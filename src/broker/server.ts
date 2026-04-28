import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

interface BridgeSocket extends WebSocket {
  isAlive?: boolean;
}

import {
  createErrorResponseFrame,
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

    try {
      await this.taskStore.init();
      await this.taskStore.gc();
      await this.bindWithFallback();

      this.pingTimer = setInterval(() => {
        const socket = this.bridgeSocket as BridgeSocket | null;
        if (!socket) {
          return;
        }
        if (socket.isAlive === false) {
          this.logger.warn?.('[pi-browser-agent] bridge heartbeat timed out');
          this.failBridge(socket, new Error('E_BRIDGE_DISCONNECTED'));
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
      brokerListening: !!this.server && !this.startupError,
      bridgeConnected: !!this.bridgeSocket && !!this.bridgeHello,
      bridgeVersion: this.bridgeHello?.version,
      capabilities: this.bridgeHello?.capabilities,
      startupError: this.startupError?.message,
      url: this.url,
      bridgeSessionSerial: this.bridgeSessionSerial,
      supportsBrokerProxy: true,
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
      this.failBridge(bridgeSocket, error);
    });

    bridgeSocket.on('close', () => {
      this.sockets.delete(bridgeSocket);
      this.failBridge(bridgeSocket, new Error('E_BRIDGE_DISCONNECTED'));
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

  private failBridge(socket: BridgeSocket, error: Error): void {
    if (this.bridgeSocket !== socket) {
      return;
    }
    this.bridgeSocket = null;
    this.bridgeHello = null;
    this.rejectPendingRequests(error);
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
      socket.send(JSON.stringify(createWelcomeFrame('0.0.0')));

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
