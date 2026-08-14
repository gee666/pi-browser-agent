import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

interface BridgeSocket extends WebSocket {
  isAlive?: boolean;
}

import {
  createErrorResponseFrame,
  createNotifyFrame,
  createResponseFrame,
  createWelcomeFrame,
  parseIncomingFrame,
  type HelloFrame,
  type ProbeResult,
  type ResponseFrame,
} from './protocol.ts';
import { TaskStore } from './task-store.ts';

export interface BrokerLogger {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
}

interface PendingRequest {
  resolve: (value: ResponseFrame) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** How long a tool call waits for the Chrome extension bridge to (re)appear
 *  before giving up. The extension reconnect backoff is capped at 5s and it has
 *  a 30s chrome.alarms cold-start backstop, so ~8s covers every warm reconnect
 *  and every "the primary pi process just died and we promoted" handoff. */
export const DEFAULT_BRIDGE_WAIT_MS = parsePositiveInt(process.env.PI_BA_BRIDGE_WAIT_MS, 8_000);

/** Short wait used when there is no reason to believe a bridge is coming back
 *  (Chrome not running / extension disabled), so tools fail fast instead of
 *  stalling every call for the full budget. */
export const COLD_BRIDGE_WAIT_MS = 1_500;

/** Grace period after the listener comes up during which we still use the full
 *  wait budget even though no bridge has ever connected — the extension needs a
 *  moment to notice the new listener. */
const FRESH_LISTENER_GRACE_MS = 20_000;

/** Number of consecutive full-budget waits that end without a bridge before we
 *  conclude the browser side is simply absent. */
export const COLD_MEMO_MISS_THRESHOLD = 2;

/** How long the "browser is cold" conclusion is trusted. Long enough to stop
 *  every tool call paying the full budget, short enough that a browser that
 *  comes back is picked up again quickly. */
export const COLD_MEMO_TTL_MS = 30_000;

export interface BridgeStateEvent {
  connected: boolean;
  probe: ProbeResult;
}

export type BridgeStateListener = (state: BridgeStateEvent) => void;

export interface EnsureReadyOptions {
  /** Override the bridge wait budget. 0 disables waiting entirely. */
  waitForBridgeMs?: number;
}

export class BrowserAgentBroker {
  readonly host: string;
  /** Port the broker actually bound to. Equals `preferredPort` after a clean
   *  bind on the first try; otherwise the first free port in the range, or an
   *  OS-assigned ephemeral port if every candidate was busy. Updated by
   *  `start()` once the underlying server is listening. */
  port: number;
  readonly preferredPort: number;
  readonly portRange: number;
  readonly fallbackToEphemeral: boolean;
  readonly logger: BrokerLogger;
  readonly requestTimeoutMs: number;
  readonly taskStore: TaskStore;

  private server: WebSocketServer | null = null;
  private bridgeSocket: WebSocket | null = null;
  private bridgeHello: HelloFrame | null = null;
  private bridgeSessionSerial = 0;
  private startupError: Error | null = null;
  private shutdownError: Error | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private sockets = new Set<BridgeSocket>();
  private listeningSince: number | null = null;
  private bridgeEverConnected = false;
  private lastBridgeConnectedAt: number | null = null;
  private lastBridgeDisconnectedAt: number | null = null;
  private lastBridgeDisconnectReason: string | null = null;
  private bridgeWaiters = new Set<(connected: boolean) => void>();
  /** Notified whenever the bridge transitions connected <-> disconnected so the
   *  host process can surface the state to the user instead of leaving them
   *  guessing why their agents "lost the browser". A set, not a single slot:
   *  several pi sessions live in one process and a single slot silenced all but
   *  the last one to start. */
  private bridgeStateListeners = new Set<BridgeStateListener>();
  /** Guards the heartbeat interval against a rebind that did not go through
   *  stop(): two live intervals make each other's pings look like heartbeat
   *  timeouts and permanently kill every bridge that connects. */
  private listenerEpoch = 0;
  private coldBridgeMisses = 0;
  private coldBridgeSince: number | null = null;

  constructor({
    host = process.env.PI_BA_HOST || '127.0.0.1',
    port = parsePositiveInt(process.env.PI_BA_PORT, 7878),
    portRange = parsePositiveInt(process.env.PI_BA_PORT_RANGE, 20),
    fallbackToEphemeral = process.env.PI_BA_NO_EPHEMERAL ? false : true,
    logger = console,
    requestTimeoutMs = 10_000,
    taskStore,
  }: {
    host?: string;
    port?: number;
    /** Number of consecutive ports to try starting at `port` before falling
     *  back to an OS-assigned ephemeral port. Defaults to 20. Set to 1 to
     *  preserve the legacy single-port behaviour. */
    portRange?: number;
    /** If every port in the range is busy, bind to port 0 (OS-assigned).
     *  Defaults to true. Set `PI_BA_NO_EPHEMERAL=1` to disable. */
    fallbackToEphemeral?: boolean;
    logger?: BrokerLogger;
    requestTimeoutMs?: number;
    taskStore: TaskStore;
  }) {
    this.host = host;
    this.preferredPort = port;
    this.port = port;
    this.portRange = Math.max(1, portRange);
    this.fallbackToEphemeral = fallbackToEphemeral;
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.taskStore = taskStore;
  }

  get url(): string {
    return `ws://${this.host}:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    this.startupError = null;

    // A previous listener generation may still have a heartbeat running (e.g.
    // ensureReady() rebinding without stop()). Two intervals would race each
    // other's pings and terminate every bridge that connects.
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    try {
      await this.taskStore.init();
      await this.taskStore.gc();
      await this.bindWithFallback();
      this.listeningSince = Date.now();

      const epoch = ++this.listenerEpoch;
      this.pingTimer = setInterval(() => {
        if (epoch !== this.listenerEpoch) return;
        const socket = this.bridgeSocket as BridgeSocket | null;
        if (!socket) {
          return;
        }
        if (socket.isAlive === false) {
          this.logger.warn?.('[pi-browser-agent] bridge heartbeat timed out');
          this.failBridge(socket, new Error('E_BRIDGE_DISCONNECTED'), 'heartbeat timeout (no pong within 25s)');
          try {
            socket.terminate();
          } catch (error) {
            this.logger.warn?.('[pi-browser-agent] failed to terminate stale bridge socket', error);
          }
          return;
        }
        socket.isAlive = false;
        try {
          socket.ping();
        } catch (error) {
          this.logger.warn?.('[pi-browser-agent] ping failed', error);
        }
      }, 25_000);
      this.pingTimer.unref?.();
    } catch (error) {
      this.startupError = error instanceof Error ? error : new Error(String(error));
      const code = (this.startupError as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        this.logger.warn?.('[pi-browser-agent] primary broker port is busy', { port: this.preferredPort });
      } else {
        this.logger.error?.('[pi-browser-agent] broker startup failed', this.startupError);
      }
      throw this.startupError;
    }
  }

  /** Lazily (re)acquire the broker listener on demand. Tools call this at the
   *  start of every request so that a process whose broker was stopped (or was
   *  never bound, or whose primary died) competes for the port at request time
   *  instead of failing permanently. No-op when already listening; on failure
   *  (e.g. another process already won the port) it leaves `startupError` set so
   *  `probeConnectivity()` reports not-listening and the caller surfaces a clear
   *  message, while a later request can still retry. */
  async ensureReady(options: EnsureReadyOptions = {}): Promise<void> {
    // 1. Make sure we still actually own a live listener. A WebSocketServer can
    //    be closed underneath us (or never have bound), and `this.server`
    //    alone is not proof of liveness — check the bound address too.
    if (this.server && !this.isListening()) {
      const dead = this.server;
      this.server = null;
      this.listeningSince = null;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      try { dead.close(); } catch { /* ignore */ }
    }

    if (!this.server) {
      try {
        await this.start();
      } catch (error) {
        this.logger.warn?.('[pi-browser-agent] ensureReady: broker (re)start failed', error);
        return;
      }
    }

    // 2. We are listening. We cannot dial Chrome, but the extension reconnects
    //    on its own within a few seconds, so absorb that window here instead of
    //    failing a tool call that arrived mid-reconnect. This is what makes the
    //    integration self-healing from the agent's point of view.
    const budget = this.resolveBridgeWaitMs(options);
    const connected = await this.waitForBridge(budget);
    this.recordBridgeWaitOutcome(connected, budget);
  }

  /** Remember that the full budget was burned without a bridge showing up, so
   *  the next calls fail fast instead of stalling the agent for 8s each time a
   *  user has Chrome closed. */
  private recordBridgeWaitOutcome(connected: boolean, budget: number): void {
    if (connected) {
      this.coldBridgeMisses = 0;
      this.coldBridgeSince = null;
      return;
    }
    if (budget < DEFAULT_BRIDGE_WAIT_MS) return;
    this.coldBridgeMisses += 1;
    if (this.coldBridgeMisses >= COLD_MEMO_MISS_THRESHOLD) {
      this.coldBridgeSince = Date.now();
    }
  }

  private resolveBridgeWaitMs({ waitForBridgeMs }: EnsureReadyOptions): number {
    if (typeof waitForBridgeMs === 'number') {
      return Math.max(0, waitForBridgeMs);
    }
    if (this.coldBridgeSince !== null && Date.now() - this.coldBridgeSince < COLD_MEMO_TTL_MS) {
      return COLD_BRIDGE_WAIT_MS;
    }
    if (this.bridgeEverConnected) {
      return DEFAULT_BRIDGE_WAIT_MS;
    }
    // Freshly bound listener: give the extension time to discover us.
    if (this.listeningSince !== null && Date.now() - this.listeningSince < FRESH_LISTENER_GRACE_MS) {
      return DEFAULT_BRIDGE_WAIT_MS;
    }
    return COLD_BRIDGE_WAIT_MS;
  }

  private isListening(): boolean {
    const server = this.server;
    if (!server) return false;
    try {
      return server.address() !== null;
    } catch {
      return false;
    }
  }

  /** Resolve as soon as a Chrome extension bridge is connected, or after
   *  `timeoutMs`. Never rejects — callers decide what to do with a still-absent
   *  bridge. */
  async waitForBridge(timeoutMs: number): Promise<boolean> {
    if (this.bridgeSocket && this.bridgeHello) return true;
    if (!this.server || timeoutMs <= 0) return false;

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        this.bridgeWaiters.delete(waiter);
        clearTimeout(timer);
        resolve(value);
      };
      const waiter = (connected: boolean) => finish(connected);
      const timer = setTimeout(() => finish(!!this.bridgeSocket && !!this.bridgeHello), timeoutMs);
      timer.unref?.();
      this.bridgeWaiters.add(waiter);
    });
  }

  private notifyBridgeWaiters(connected: boolean): void {
    const waiters = [...this.bridgeWaiters];
    this.bridgeWaiters.clear();
    for (const waiter of waiters) {
      try { waiter(connected); } catch { /* ignore */ }
    }
  }

  /** Subscribe to bridge connect/disconnect transitions. Returns an
   *  unsubscribe function; call it when a session ends so a dead session does
   *  not keep receiving (or swallowing) notifications. */
  addBridgeStateListener(listener: BridgeStateListener): () => void {
    this.bridgeStateListeners.add(listener);
    return () => {
      this.bridgeStateListeners.delete(listener);
    };
  }

  private emitBridgeStateChange(connected: boolean): void {
    const probe = this.probeConnectivity();
    for (const listener of [...this.bridgeStateListeners]) {
      try {
        listener({ connected, probe });
      } catch (error) {
        this.logger.warn?.('[pi-browser-agent] bridge state listener failed', error);
      }
    }

    // Peer pi brokers proxy through us and cannot see our bridge directly. Push
    // the transition so their users are told the browser went away instead of
    // being left with a stale "connected" snapshot until the next poll.
    const payload = JSON.stringify(createNotifyFrame('bridge_state', probe));
    for (const socket of this.sockets) {
      if (socket === this.bridgeSocket) continue;
      try {
        socket.send(payload);
      } catch (error) {
        this.logger.warn?.('[pi-browser-agent] failed to notify peer broker', error);
      }
    }
  }

  /** Try to bind to the preferred port, walk up the configured range on
   *  EADDRINUSE, and finally fall back to an OS-assigned ephemeral port.
   *  Updates `this.port` to the actual bound port on success. */
  private async bindWithFallback(): Promise<void> {
    const candidates: number[] = [];
    for (let i = 0; i < this.portRange; i += 1) {
      candidates.push(this.preferredPort + i);
    }
    if (this.fallbackToEphemeral) {
      candidates.push(0);
    }

    let lastError: Error | null = null;
    for (const candidate of candidates) {
      try {
        await this.tryBind(candidate);
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error('Failed to bind broker to any candidate port');
  }

  private async tryBind(candidate: number): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({ host: this.host, port: candidate });

      const onError = (error: Error) => {
        server.off('listening', onListening);
        this.server = null;
        try {
          server.close();
        } catch {
          // ignore; server never finished binding
        }
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        } else {
          this.port = candidate;
        }
        this.server = server;
        // Only log post-listen server errors. Startup bind errors such as an
        // expected EADDRINUSE fallback are handled by onError and should not
        // be printed as scary broker failures.
        server.on('error', (error: Error) => {
          this.logger.error?.('[pi-browser-agent] broker server error', error);
        });
        resolve();
      };

      server.once('error', onError);
      server.once('listening', onListening);
      server.on('connection', (socket: WebSocket) => {
        void this.handleConnection(socket);
      });
    });
  }

  async stop(): Promise<void> {
    const closeErrors: Error[] = [];

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this.rejectPendingRequests(new Error('E_BRIDGE_DISCONNECTED'));

    // Anyone parked in waitForBridge() must be released now; otherwise a tool
    // call that raced the shutdown hangs for the whole 8s budget.
    this.notifyBridgeWaiters(false);
    this.bridgeStateListeners.clear();

    for (const socket of this.sockets) {
      try {
        socket.close();
      } catch (error) {
        closeErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (this.bridgeSocket) {
      try {
        this.bridgeSocket.close();
      } catch (error) {
        closeErrors.push(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.bridgeSocket = null;
        this.bridgeHello = null;
      }
    }

    this.listeningSince = null;

    if (this.server) {
      const server = this.server;
      this.server = null;
      try {
        await new Promise<void>((resolve, reject) => {
          const forceClose = setTimeout(() => {
            for (const socket of this.sockets) {
              try { socket.terminate(); } catch { /* ignore */ }
            }
          }, 250);
          forceClose.unref?.();
          server.close((error) => {
            clearTimeout(forceClose);
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      } catch (error) {
        closeErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    if (closeErrors.length > 0) {
      this.shutdownError = closeErrors[0];
      this.logger.error?.('[pi-browser-agent] broker shutdown failed', this.shutdownError);
      throw new AggregateError(closeErrors, 'Broker shutdown failed');
    }
  }

  async request(type: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<ResponseFrame> {
    const socket = this.bridgeSocket;
    if (!socket || !this.bridgeHello) {
      throw new Error('E_BRIDGE_DISCONNECTED');
    }

    const id = randomUUID();
    const payload = JSON.stringify({ v: 1, kind: 'request', id, type, params });

    return await new Promise<ResponseFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${type}`));
      }, options.timeoutMs ?? this.requestTimeoutMs);
      timeout.unref?.();

      this.pendingRequests.set(id, { resolve, reject, timeout });

      // If the bridge went away between our validation and send, reject fast
      // so callers get a direct disconnect error instead of waiting for a timeout.
      if (this.bridgeSocket !== socket) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(new Error('E_BRIDGE_DISCONNECTED'));
        return;
      }

      try {
        socket.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  probeConnectivity(): ProbeResult {
    return {
      brokerReachable: !this.startupError,
      brokerListening: this.isListening() && !this.startupError,
      bridgeConnected: !!this.bridgeSocket && !!this.bridgeHello,
      bridgeVersion: this.bridgeHello?.version,
      capabilities: this.bridgeHello?.capabilities,
      startupError: this.startupError?.message,
      url: this.url,
      bridgeSessionSerial: this.bridgeSessionSerial,
      supportsBrokerProxy: true,
      role: 'primary',
      ownerPid: process.pid,
      listeningSince: this.listeningSince ? new Date(this.listeningSince).toISOString() : undefined,
      bridgeEverConnected: this.bridgeEverConnected,
      lastBridgeConnectedAt: this.lastBridgeConnectedAt ? new Date(this.lastBridgeConnectedAt).toISOString() : undefined,
      lastBridgeDisconnectedAt: this.lastBridgeDisconnectedAt ? new Date(this.lastBridgeDisconnectedAt).toISOString() : undefined,
      lastBridgeDisconnectReason: this.lastBridgeDisconnectReason ?? undefined,
    };
  }

  private async handleConnection(socket: WebSocket): Promise<void> {
    const bridgeSocket = socket as BridgeSocket;
    bridgeSocket.isAlive = true;
    this.sockets.add(bridgeSocket);

    // Do NOT evict the current bridge here. A new accepted socket has not yet
    // authenticated as a bridge session. We only replace the active bridge
    // once this socket sends a valid `hello` frame (see handleRawMessage).

    bridgeSocket.on('pong', () => {
      bridgeSocket.isAlive = true;
    });

    bridgeSocket.on('error', (error: Error) => {
      this.logger.warn?.('[pi-browser-agent] bridge socket error', error);
      this.failBridge(bridgeSocket, error, `socket error: ${error.message}`);
    });

    bridgeSocket.on('close', (code?: number, reason?: Buffer) => {
      this.sockets.delete(bridgeSocket);
      const detail = reason?.length ? ` ${reason.toString()}` : '';
      this.failBridge(bridgeSocket, new Error('E_BRIDGE_DISCONNECTED'), `socket closed (code ${code ?? 'unknown'})${detail}`);
    });

    bridgeSocket.on('message', (buffer: RawData) => {
      try {
        this.handleRawMessage(bridgeSocket, buffer.toString());
      } catch (error) {
        this.logger.warn?.('[pi-browser-agent] invalid bridge frame', error);
      }
    });
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }

  private failBridge(socket: BridgeSocket, error: Error, reason?: string): void {
    if (this.bridgeSocket !== socket) {
      return;
    }
    this.bridgeSocket = null;
    this.bridgeHello = null;
    this.lastBridgeDisconnectedAt = Date.now();
    this.lastBridgeDisconnectReason = reason ?? error.message;
    this.rejectPendingRequests(error);
    this.logger.warn?.('[pi-browser-agent] browser extension bridge lost', { reason: this.lastBridgeDisconnectReason });
    this.emitBridgeStateChange(false);
  }

  private handleRawMessage(socket: WebSocket, raw: string): void {
    const frame = parseIncomingFrame(raw);

    if (frame.kind === 'hello') {
      // Promote this socket to the active bridge. Capture the previous one in
      // a local so we can close it explicitly after state has been swapped.
      const previous = this.bridgeSocket as BridgeSocket | null;
      const isHandoff = previous !== null && previous !== socket;

      this.bridgeSocket = socket;
      this.bridgeHello = frame;
      this.bridgeSessionSerial += 1;
      this.bridgeEverConnected = true;
      this.lastBridgeConnectedAt = Date.now();
      this.coldBridgeMisses = 0;
      this.coldBridgeSince = null;
      socket.send(JSON.stringify(createWelcomeFrame('0.0.0')));
      this.notifyBridgeWaiters(true);
      this.emitBridgeStateChange(true);

      if (isHandoff && previous) {
        this.rejectPendingRequests(new Error('E_BRIDGE_DISCONNECTED'));
        try {
          previous.close(1012, 'Superseded by a newer bridge connection');
        } catch (error) {
          this.logger.warn?.('[pi-browser-agent] failed to close stale bridge socket', error);
        }
      }
      return;
    }

    if (frame.kind === 'probe') {
      const id = frame.id || randomUUID();
      socket.send(JSON.stringify(createResponseFrame(id, this.probeConnectivity())));
      return;
    }

    if (frame.kind === 'response') {
      const pending = this.pendingRequests.get(frame.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(frame.id);
      pending.resolve(frame);
      return;
    }

    if (frame.kind === 'request') {
      // Local peer brokers use request frames to proxy browser tool calls
      // through the primary broker's single Chrome extension bridge. The
      // extension itself does not send request frames to the broker, so this
      // is safe and avoids requiring Chrome/MV3 to maintain one WebSocket per
      // pi process.
      void this.request(frame.type, frame.params)
        .then((response) => {
          socket.send(JSON.stringify({ ...response, id: frame.id }));
        })
        .catch((error) => {
          socket.send(JSON.stringify(createErrorResponseFrame(
            frame.id,
            'E_BRIDGE_DISCONNECTED',
            error instanceof Error ? error.message : String(error),
          )));
        });
    }
  }
}
