import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';

import {
  createErrorResponseFrame,
  parseIncomingFrame,
  type ProbeResult,
  type ResponseFrame,
} from './protocol.ts';
import { TaskStore } from './task-store.ts';
import { BrowserAgentBroker, type BrokerLogger } from './server.ts';

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
  private connectPromise: Promise<void> | null = null;
  private pendingRequests = new Map<string, PendingRequest>();
  private startupError: Error | null = null;
  private remoteProbe: ProbeResult | null = null;
  private promotedBroker: BrowserAgentBroker | null = null;
  private promotionPromise: Promise<BrowserAgentBroker | null> | null = null;

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

  async stop(): Promise<void> {
    this.rejectPendingRequests(new Error('E_BRIDGE_DISCONNECTED'));
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
    }
    if (this.promotedBroker) {
      const broker = this.promotedBroker;
      this.promotedBroker = null;
      await broker.stop();
    }
  }

  async request(type: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<ResponseFrame> {
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
      return this.promotedBroker.probeConnectivity();
    }
    const primary = this.remoteProbe;
    if (primary) {
      return {
        ...primary,
        brokerReachable: !this.startupError && primary.brokerReachable,
        brokerListening: !this.startupError && primary.brokerListening,
        startupError: this.startupError?.message || primary.startupError,
        url: this.url,
      };
    }
    return {
      brokerReachable: !this.startupError && !!this.socket,
      brokerListening: !this.startupError && !!this.socket,
      bridgeConnected: false,
      startupError: this.startupError?.message,
      url: this.url,
      bridgeSessionSerial: 0,
    };
  }

  private async probePrimary(): Promise<ProbeResult> {
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
      this.pendingRequests.set(id, { resolve, reject, timeout });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connectPromise) return await this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url);
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
        settled = true;
        clearTimeout(connectTimeout);
        this.socket = socket;
        this.connectPromise = null;

        socket.on('message', (buffer: RawData) => this.handleRawMessage(buffer.toString()));
        socket.on('close', () => {
          if (this.socket === socket) {
            this.socket = null;
            this.rejectPendingRequests(new Error('E_BRIDGE_DISCONNECTED'));
            void this.promoteOrReconnect();
          }
        });
        socket.on('error', (error) => {
          this.logger.warn?.('[pi-browser-agent] primary broker proxy socket error', error);
          if (this.socket === socket) {
            this.socket = null;
            this.rejectPendingRequests(error instanceof Error ? error : new Error(String(error)));
            void this.promoteOrReconnect();
          }
        });
        resolve();
      });
      socket.once('error', () => fail(new Error(`Port ${this.port} is busy, but it is not a pi-browser-agent broker`)));
      socket.once('unexpected-response', () => fail(new Error(`Port ${this.port} is busy, but it is not a pi-browser-agent broker`)));
    });

    return await this.connectPromise;
  }

  private async promoteOrReconnect(): Promise<BrowserAgentBroker | null> {
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
        this.promotedBroker = candidate;
        this.remoteProbe = candidate.probeConnectivity();
        this.startupError = null;
        this.logger.info?.('[pi-browser-agent] promoted secondary broker to primary', { url: candidate.url });
        return candidate;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'EADDRINUSE') {
          this.logger.warn?.('[pi-browser-agent] secondary broker promotion failed', error);
          return null;
        }
        // Someone else won the race. Reconnect to the new primary and refresh
        // our probe snapshot.
        try {
          await this.ensureConnected();
          this.remoteProbe = await this.probePrimary();
          this.startupError = null;
        } catch (reconnectError) {
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
