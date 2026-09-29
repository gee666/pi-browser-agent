import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';

import {
  createErrorResponseFrame,
  parseIncomingFrame,
  type ProbeResult,
  type ResponseFrame,
} from './protocol.ts';
import { TaskStore } from './task-store.ts';
import {
  BrowserAgentBroker,
  COLD_BRIDGE_WAIT_MS,
  COLD_MEMO_MISS_THRESHOLD,
  COLD_MEMO_TTL_MS,
  DEFAULT_BRIDGE_WAIT_MS,
  type BridgeStateEvent,
  type BridgeStateListener,
  type BrokerLogger,
  type EnsureReadyOptions,
} from './server.ts';

interface PendingRequest {
  resolve: (value: ResponseFrame) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * BrowserAgentBroker-compatible client for secondary pi processes.
 *
 * Only the primary broker owns the Chrome extension bridge (usually on 7878).
 * Secondary pi processes should not require Chrome/MV3 to maintain extra
 * WebSocket clients to fallback ports. Instead they proxy tool requests through
 * the primary broker, which forwards them to its already-connected extension
 * bridge.
 */
export class RemoteBrowserAgentBroker {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly logger: BrokerLogger;
  readonly requestTimeoutMs: number;
  readonly taskStore: TaskStore;

  private socket: WebSocket | null = null;
  private validatedSocket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private startupError: Error | null = null;
  private remoteProbe: ProbeResult | null = null;
  private promotedBroker: BrowserAgentBroker | null = null;
  private promotionPromise: Promise<BrowserAgentBroker | null> | null = null;
  private healTimer: ReturnType<typeof setTimeout> | null = null;
  private healAttempt = 0;
  private stopped = false;
  private bridgeStateListeners = new Set<BridgeStateListener>();
  private promotionListeners = new Set<(broker: BrowserAgentBroker) => void>();
  private unsubscribePromoted: (() => void) | null = null;
  /** Consecutive full-budget waits that found no bridge, plus when we gave up.
   *  Without this every tool call on a secondary with Chrome closed burns the
   *  whole budget again. */
  private coldBridgeMisses = 0;
  private coldBridgeSince: number | null = null;

  constructor({
    host = '127.0.0.1',
    port = 7878,
    logger = console,
    requestTimeoutMs = 10_000,
    taskStore,
  }: {
    host?: string;
    port?: number;
    logger?: BrokerLogger;
    requestTimeoutMs?: number;
    taskStore: TaskStore;
  }) {
    this.host = host;
    this.port = port;
    this.url = `ws://${host}:${port}`;
    this.logger = logger;
    this.requestTimeoutMs = requestTimeoutMs;
    this.taskStore = taskStore;
  }

  async start(): Promise<void> {
    // start() is also the resume path after SIGTSTP called stop(). Leaving
    // `stopped` set there disabled background healing forever, so a single
    // Ctrl+Z left the session with no recovery path at all.
    this.stopped = false;
    this.healAttempt = 0;
    this.startupError = null;
    await this.taskStore.init();
    await this.taskStore.gc();
    try {
      await this.ensureConnected();
      this.remoteProbe = await this.probePrimary();
      this.logger.info?.('[pi-browser-agent] using primary broker proxy', { url: this.url });
    } catch (error) {
      this.startupError = error instanceof Error ? error : new Error(String(error));
      const message = this.startupError.message;
      if (message.includes('not a pi-browser-agent broker') || message.includes('old pi-browser-agent broker')) {
        this.logger.warn?.(`[pi-browser-agent] ${message}`);
      } else {
        this.logger.error?.('[pi-browser-agent] primary broker proxy startup failed', this.startupError);
      }
      throw this.startupError;
    }
  }

  /** Lazily ensure a primary broker is reachable on demand. Tools call this at
   *  the start of every request so a killed primary is replaced without waiting
   *  for the socket-close handler: reconnect to the current primary, or (if
   *  none is listening) compete to become the new primary. Idempotent and safe
   *  to call concurrently — `promoteOrReconnect()` dedupes the bind race. */
  async ensureReady(options: EnsureReadyOptions = {}): Promise<void> {
    if (this.stopped) return;
    if (this.promotedBroker) {
      await this.promotedBroker.ensureReady(options);
      return;
    }
    try {
      await this.ensureConnected();
      this.remoteProbe = await this.probePrimary();
      this.startupError = null;
    } catch {
      const promoted = await this.promoteOrReconnect();
      if (promoted) {
        await promoted.ensureReady(options);
        return;
      }
    }

    // The primary is reachable but its Chrome bridge may be mid-reconnect.
    // Poll the primary's probe for the same budget a local broker would wait,
    // so a tool call arriving during a reconnect window succeeds instead of
    // reporting a hard "connection is down".
    await this.waitForRemoteBridge(options.waitForBridgeMs ?? this.defaultRemoteBridgeWaitMs());
  }

  /** Full budget only when the primary has actually seen a bridge at some point.
   *  If Chrome has never connected there is nothing to wait for, and stalling
   *  every tool call for the full budget would be pure latency. */
  private defaultRemoteBridgeWaitMs(): number {
    if (this.coldBridgeSince !== null && Date.now() - this.coldBridgeSince < COLD_MEMO_TTL_MS) {
      return COLD_BRIDGE_WAIT_MS;
    }
    return this.remoteProbe?.bridgeEverConnected === false ? COLD_BRIDGE_WAIT_MS : DEFAULT_BRIDGE_WAIT_MS;
  }

  private async waitForRemoteBridge(timeoutMs: number): Promise<boolean> {
    if (this.probeConnectivity().bridgeConnected) {
      this.coldBridgeMisses = 0;
      this.coldBridgeSince = null;
      return true;
    }
    if (timeoutMs <= 0) return false;
    const deadline = Date.now() + timeoutMs;
    // Every sub-step below can block for up to ~1.5s, so the budget is
    // re-checked before each of them. Checking only at the top of the loop let a
    // final iteration overrun by several seconds, which is what turned an 8s
    // budget into ~17s stalls on every single tool call.
    while (Date.now() < deadline) {
      const sleepMs = Math.min(250, deadline - Date.now());
      if (sleepMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, sleepMs).unref?.());
      }
      if (this.stopped) return false;
      if (Date.now() >= deadline) break;
      try {
        await this.ensureConnected();
        if (Date.now() >= deadline) break;
        this.remoteProbe = await this.probePrimary();
        this.startupError = null;
        if (this.remoteProbe.bridgeConnected) {
          this.coldBridgeMisses = 0;
          this.coldBridgeSince = null;
          return true;
        }
      } catch {
        if (Date.now() >= deadline) break;
        const promoted = await this.promoteOrReconnect();
        if (promoted) {
          const found = await promoted.waitForBridge(Math.max(0, deadline - Date.now()));
          this.recordBridgeWaitOutcome(found, timeoutMs);
          return found;
        }
      }
    }
    const connected = this.probeConnectivity().bridgeConnected;
    this.recordBridgeWaitOutcome(connected, timeoutMs);
    return connected;
  }

  /** Remember that a full budget was spent without ever seeing a bridge, so the
   *  next calls fail fast on a short budget instead of stalling the agent for
   *  the full window on every request while Chrome is closed. */
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

  /** Subscribe to bridge connect/disconnect transitions, whether they come from
   *  a broker we promoted ourselves or from a `notify` push by the primary. */
  addBridgeStateListener(listener: BridgeStateListener): () => void {
    this.bridgeStateListeners.add(listener);
    return () => {
      this.bridgeStateListeners.delete(listener);
    };
  }

  /** Fired when this secondary wins the bind race and becomes the primary, so
   *  the host process can republish instance discovery (which would otherwise
   *  keep pointing at the dead primary). */
  addPromotionListener(listener: (broker: BrowserAgentBroker) => void): () => void {
    this.promotionListeners.add(listener);
    return () => {
      this.promotionListeners.delete(listener);
    };
  }

  private emitBridgeState(state: BridgeStateEvent): void {
    for (const listener of [...this.bridgeStateListeners]) {
      try {
        listener(state);
      } catch (error) {
        this.logger.warn?.('[pi-browser-agent] bridge state listener failed', error);
      }
    }
  }

  private closeSocket(terminate = false): void {
    const socket = this.socket;
    this.socket = null;
    this.validatedSocket = null;
    if (socket) {
      try {
        if (terminate) socket.terminate();
        else socket.close();
      } catch { /* ignore */ }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelHealTimer();
    this.rejectPendingRequests(new Error('E_BRIDGE_DISCONNECTED'));
    const connecting = this.connectPromise;
    this.closeSocket();
    // A connect or promotion already in flight can otherwise publish a socket
    // or listener after stop() returns. Their completion paths observe
    // `stopped` and tear down instead of publishing.
    if (connecting) {
      try { await connecting; } catch { /* expected during shutdown */ }
    }
    this.connectPromise = null;
    const promotion = this.promotionPromise;
    if (promotion) {
      try { await promotion; } catch { /* promotion failure is already logged */ }
    }
    // Read the socket again after async work, which may have replaced it.
    this.closeSocket();
    this.unsubscribePromoted?.();
    this.unsubscribePromoted = null;
    this.bridgeStateListeners.clear();
    this.promotionListeners.clear();
    if (this.promotedBroker) {
      const broker = this.promotedBroker;
      this.promotedBroker = null;
      await broker.stop();
    }
  }

  async request(type: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<ResponseFrame> {
    if (this.stopped) throw new Error('E_BRIDGE_DISCONNECTED');
    if (this.promotedBroker) {
      return await this.promotedBroker.request(type, params, options);
    }

    try {
      await this.ensureConnected();
    } catch {
      const promoted = await this.promoteOrReconnect();
      if (promoted) return await promoted.request(type, params, options);
      await this.ensureConnected();
    }

    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      const promoted = await this.promoteOrReconnect();
      if (promoted) return await promoted.request(type, params, options);
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
    if (this.promotedBroker) {
      return { ...this.promotedBroker.probeConnectivity(), role: 'promoted' };
    }
    const primary = this.remoteProbe;
    if (primary) {
      // A cached snapshot must never claim a live broker/bridge once our own
      // socket to the primary is gone; otherwise tools happily send requests
      // into a dead proxy and only fail on timeout, and callers cannot tell
      // "healed" from "still using a stale snapshot".
      const proxyAlive = this.hasValidatedConnection();
      return {
        ...primary,
        brokerReachable: proxyAlive && primary.brokerReachable,
        brokerListening: proxyAlive && primary.brokerListening,
        bridgeConnected: proxyAlive && primary.bridgeConnected,
        startupError: this.startupError?.message || primary.startupError,
        url: this.url,
        role: 'proxy',
      };
    }
    return {
      brokerReachable: this.hasValidatedConnection(),
      brokerListening: this.hasValidatedConnection(),
      bridgeConnected: false,
      startupError: this.startupError?.message,
      url: this.url,
      bridgeSessionSerial: 0,
      role: 'proxy',
    };
  }

  private hasValidatedConnection(): boolean {
    return !!this.socket && this.socket === this.validatedSocket
      && this.socket.readyState === WebSocket.OPEN && !this.startupError;
  }

  private async probePrimary(): Promise<ProbeResult> {
    await this.ensureConnected();
    const socket = this.socket;
    const response = await this.sendControlRequest('probe');
    if (!response.ok) {
      throw new Error(response.error?.message || 'Primary broker probe failed');
    }
    const data = response.data as Partial<ProbeResult> | undefined;
    if (!data || typeof data.brokerListening !== 'boolean' || typeof data.bridgeConnected !== 'boolean') {
      throw new Error(`Port ${this.port} is busy, but it is not a pi-browser-agent broker`);
    }
    if (data.supportsBrokerProxy !== true) {
      throw new Error(`Port ${this.port} has an old pi-browser-agent broker; restart the first pi instance`);
    }
    if (this.stopped || this.socket !== socket || socket?.readyState !== WebSocket.OPEN) {
      throw new Error('E_BRIDGE_DISCONNECTED');
    }
    this.validatedSocket = socket;
    return data as ProbeResult;
  }

  private async sendControlRequest(kind: 'probe'): Promise<ResponseFrame> {
    await this.ensureConnected();
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return createErrorResponseFrame(randomUUID(), 'E_BRIDGE_DISCONNECTED', 'Primary broker proxy is not connected');
    }

    const id = randomUUID();
    socket.send(JSON.stringify({ v: 1, kind, id }));

    return await new Promise<ResponseFrame>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Port ${this.port} is busy, but it is not a pi-browser-agent broker`));
      }, Math.min(this.requestTimeoutMs, 1500));
      timeout.unref?.();
      this.pendingRequests.set(id, { resolve, reject, timeout });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.stopped) throw new Error('Browser broker is stopped');
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return await this.connectPromise;

    // Construct the socket OUTSIDE the promise: a synchronous throw from the
    // WebSocket constructor used to be captured into `connectPromise` after the
    // executor's own `this.connectPromise = null` had already run, permanently
    // caching a rejected promise so every later ensureConnected() failed.
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }

    const pending = new Promise<void>((resolve, reject) => {
      let settled = false;
      const connectTimeout = setTimeout(() => {
        fail(new Error(`Port ${this.port} is busy, but it is not a pi-browser-agent broker`));
      }, Math.min(this.requestTimeoutMs, 1500));
      connectTimeout.unref?.();

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        this.connectPromise = null;
        try { socket.terminate(); } catch { try { socket.close(); } catch { /* ignore */ } }
        reject(error);
      };

      socket.once('open', () => {
        if (this.stopped) {
          fail(new Error('Browser broker is stopped'));
          return;
        }
        settled = true;
        clearTimeout(connectTimeout);
        this.socket = socket;
        this.connectPromise = null;

        socket.on('message', (buffer: RawData) => this.handleRawMessage(buffer.toString()));
        socket.on('close', () => {
          if (this.socket === socket) {
            this.socket = null;
            this.rejectPendingRequests(new Error('E_BRIDGE_DISCONNECTED'));
            void this.healInBackground('primary broker socket closed');
          }
        });
        socket.on('error', (error) => {
          this.logger.warn?.('[pi-browser-agent] primary broker proxy socket error', error);
          if (this.socket === socket) {
            this.socket = null;
            this.rejectPendingRequests(error instanceof Error ? error : new Error(String(error)));
            void this.healInBackground('primary broker socket error');
          }
        });
        resolve();
      });
      socket.once('error', () => fail(new Error(`Port ${this.port} is busy, but it is not a pi-browser-agent broker`)));
      socket.once('unexpected-response', () => fail(new Error(`Port ${this.port} is busy, but it is not a pi-browser-agent broker`)));
    });

    // Belt and braces: never leave a rejected promise cached, whatever path the
    // failure took.
    this.connectPromise = pending.catch((error) => {
      this.connectPromise = null;
      throw error;
    });

    return await this.connectPromise;
  }

  /**
   * Keep trying to reattach to (or become) a primary broker in the background.
   *
   * Without this, recovery only ever happened when an agent made a tool call:
   * if the primary pi process died at 3am, every secondary sat disconnected
   * until someone poked it, and the Chrome extension had no listener at all to
   * reconnect to. The retry loop closes that hole so the port is re-owned within
   * seconds of the primary disappearing, whether or not anyone is asking.
   */
  private async healInBackground(reason: string): Promise<void> {
    if (this.stopped) return;
    this.logger.warn?.('[pi-browser-agent] lost primary broker; healing', { reason });
    const promoted = await this.promoteOrReconnect();
    if (promoted || this.hasValidatedConnection()) {
      this.healAttempt = 0;
      this.cancelHealTimer();
      return;
    }
    this.scheduleHeal();
  }

  private scheduleHeal(): void {
    if (this.stopped || this.healTimer) return;
    const delays = [500, 1_000, 2_000, 3_000, 5_000];
    const delay = delays[Math.min(this.healAttempt, delays.length - 1)];
    this.healAttempt += 1;
    this.healTimer = setTimeout(() => {
      this.healTimer = null;
      void this.healInBackground('scheduled reconnect retry');
    }, delay);
    this.healTimer.unref?.();
  }

  private cancelHealTimer(): void {
    if (this.healTimer) {
      clearTimeout(this.healTimer);
      this.healTimer = null;
    }
  }

  private async promoteOrReconnect(): Promise<BrowserAgentBroker | null> {
    if (this.stopped) return null;
    if (this.promotedBroker) return this.promotedBroker;
    if (this.promotionPromise) return await this.promotionPromise;

    this.promotionPromise = (async () => {
      // First try to become the new primary. If several remotes detect the
      // disconnect at once, exactly one should win this bind race.
      const candidate = new BrowserAgentBroker({
        host: this.host,
        port: this.port,
        portRange: 1,
        fallbackToEphemeral: false,
        logger: this.logger,
        requestTimeoutMs: this.requestTimeoutMs,
        taskStore: this.taskStore,
      });
      try {
        await candidate.start();
        if (this.stopped) {
          await candidate.stop();
          return null;
        }
        this.unsubscribePromoted?.();
        this.unsubscribePromoted = candidate.addBridgeStateListener((state) => this.emitBridgeState(state));
        this.promotedBroker = candidate;
        this.remoteProbe = candidate.probeConnectivity();
        this.startupError = null;
        this.healAttempt = 0;
        this.cancelHealTimer();
        this.logger.info?.('[pi-browser-agent] promoted secondary broker to primary', { url: candidate.url });
        for (const listener of [...this.promotionListeners]) {
          try {
            listener(candidate);
          } catch (error) {
            this.logger.warn?.('[pi-browser-agent] promotion listener failed', error);
          }
        }
        return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'EADDRINUSE') {
          this.logger.warn?.('[pi-browser-agent] secondary broker promotion failed', error);
          return null;
        }
        // Someone else won the race. Reconnect to the new primary and refresh
        // our probe snapshot, unless shutdown won the race first.
        if (this.stopped) return null;
        try {
          await this.ensureConnected();
          this.remoteProbe = await this.probePrimary();
          this.startupError = null;
        } catch (reconnectError) {
          this.startupError = reconnectError instanceof Error ? reconnectError : new Error(String(reconnectError));
          // A WebSocket handshake alone does not identify a broker. Discard
          // failed probes immediately rather than waiting for a close handshake.
          this.closeSocket(true);
          this.rejectPendingRequests(this.startupError);
          this.scheduleHeal();
          this.logger.warn?.('[pi-browser-agent] failed to reconnect to promoted primary broker', reconnectError);
        }
        return null;
      } finally {
        this.promotionPromise = null;
      }
    })();

    return await this.promotionPromise;
  }

  private handleRawMessage(raw: string): void {
    let frame;
    try {
      frame = parseIncomingFrame(raw);
    } catch (error) {
      this.logger.warn?.('[pi-browser-agent] invalid primary proxy frame', error);
      return;
    }
    // The primary pushes bridge transitions instead of making us poll, so a
    // secondary session can tell its user the browser went away.
    if (frame.kind === 'notify') {
      if (frame.event !== 'bridge_state') return;
      const payload = frame.payload as Partial<ProbeResult> | undefined;
      if (payload && typeof payload === 'object') {
        this.remoteProbe = { ...(this.remoteProbe ?? {} as ProbeResult), ...payload };
      }
      const probe = this.probeConnectivity();
      if (probe.bridgeConnected) {
        this.coldBridgeMisses = 0;
        this.coldBridgeSince = null;
      }
      this.emitBridgeState({ connected: probe.bridgeConnected, probe });
      return;
    }

    if (frame.kind !== 'response') return;
    const pending = this.pendingRequests.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(frame.id);
    pending.resolve(frame);
  }

  private rejectPendingRequests(error: Error): void {
    for (const [id, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(id);
    }
  }
}
