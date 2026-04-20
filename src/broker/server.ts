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

export class BrowserAgentBroker {
  readonly host: string;
  readonly port: number;
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

  constructor({
    host = process.env.PI_BA_HOST || '127.0.0.1',
    port = Number(process.env.PI_BA_PORT || 7878),
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
      await new Promise<void>((resolve, reject) => {
        const server = new WebSocketServer({ host: this.host, port: this.port });
        this.server = server;

        const onError = (error: Error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.on('connection', (socket: WebSocket) => {
          void this.handleConnection(socket);
        });
        server.on('error', (error: Error) => {
          this.logger.error?.('[pi-browser-agent] broker server error', error);
        });
      });

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
      this.logger.info?.('[pi-browser-agent] broker listening', { url: this.url });
    } catch (error) {
      this.startupError = error instanceof Error ? error : new Error(String(error));
      this.logger.error?.('[pi-browser-agent] broker startup failed', this.startupError);
    }
  }

  async stop(): Promise<void> {
    const closeErrors: Error[] = [];

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    this.rejectPendingRequests(new Error('E_BRIDGE_DISCONNECTED'));

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
          server.close((error) => {
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
    if (!this.bridgeSocket || !this.bridgeHello) {
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
        this.bridgeSocket?.send(payload);
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
    };
  }

  private async handleConnection(socket: WebSocket): Promise<void> {
    const bridgeSocket = socket as BridgeSocket;
    bridgeSocket.isAlive = true;

    if (this.bridgeSocket && this.bridgeSocket !== socket) {
      this.failBridge(this.bridgeSocket as BridgeSocket, new Error('E_BRIDGE_DISCONNECTED'));
      try {
        this.bridgeSocket.close(1012, 'Superseded by a newer bridge connection');
      } catch (error) {
        this.logger.warn?.('[pi-browser-agent] failed to close stale bridge socket', error);
      }
    }

    bridgeSocket.on('pong', () => {
      bridgeSocket.isAlive = true;
    });

    bridgeSocket.on('error', (error: Error) => {
      this.logger.warn?.('[pi-browser-agent] bridge socket error', error);
      this.failBridge(bridgeSocket, error);
    });

    bridgeSocket.on('close', () => {
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
      this.bridgeSocket = socket;
      this.bridgeHello = frame;
      this.bridgeSessionSerial += 1;
      socket.send(JSON.stringify(createWelcomeFrame('0.0.0')));
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
      socket.send(JSON.stringify(createErrorResponseFrame(frame.id, 'E_UNKNOWN_TYPE', `Unknown request type: ${frame.type}`)));
    }
  }
}
