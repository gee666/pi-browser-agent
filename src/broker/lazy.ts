import type { ProbeResult, ResponseFrame } from './protocol.ts';
import type { EnsureReadyOptions } from './server.ts';
import type { TaskStore } from './task-store.ts';

/** The slice of the broker API that the browser_* tools actually consume. */
export interface BrokerLike {
  ensureReady?: (options?: EnsureReadyOptions) => Promise<void>;
  probeConnectivity: () => ProbeResult;
  request: (type: string, params: unknown, options?: { timeoutMs?: number }) => Promise<ResponseFrame>;
  taskStore: TaskStore;
}

/**
 * A broker handle that resolves its real backing broker lazily, on every call.
 *
 * Why this exists: pi reads the tool registry once at session_start, and any
 * registerTool() after that is dropped. Previously the browser_* suite was only
 * registered when the broker happened to be listening at session_start, so a pi
 * instance started while the browser stack was down had NO browser tools for its
 * entire lifetime — unrecoverable without restarting pi. And a session whose
 * broker later died held a dead object forever.
 *
 * With this handle the tools are always registered and always re-resolve the
 * broker at call time, so the integration heals itself whenever the browser
 * comes back — no restart, no manual step.
 */
export class LazyBrokerHandle implements BrokerLike {
  private current: BrokerLike | null = null;
  private lastError: string | undefined;
  private resolving: Promise<BrokerLike | null> | null = null;
  private disposed = false;
  /** Last bridge session serial we actually observed. Reporting 0 while
   *  unresolved made browser_reload_extension's "serial must increase" wait
   *  never succeed, because the serial appeared to go N -> 0. */
  private lastSeenBridgeSessionSerial = 0;

  readonly taskStore: TaskStore;
  private readonly resolveBroker: () => Promise<BrokerLike>;
  private readonly url: string;

  constructor(resolveBroker: () => Promise<BrokerLike>, taskStore: TaskStore, url?: string) {
    this.resolveBroker = resolveBroker;
    this.taskStore = taskStore;
    this.url = url ?? `ws://${process.env.PI_BA_HOST || '127.0.0.1'}:${process.env.PI_BA_PORT || 7878}`;
  }

  /** Attach an already-resolved broker (the happy path at session_start). */
  adopt(broker: BrokerLike): void {
    if (this.disposed) return;
    this.current = broker;
    this.lastError = undefined;
  }

  /** Detach permanently. Tools captured this handle for the whole session, so
   *  without this a late tool call would happily re-start() the broker the
   *  session shutdown had just stopped — re-binding the port with nothing left
   *  to track or close it. */
  dispose(): void {
    this.disposed = true;
    this.current = null;
    this.resolving = null;
    this.lastError = 'browser broker was shut down with this pi session';
  }

  get resolved(): BrokerLike | null {
    return this.current;
  }

  private async resolve(): Promise<BrokerLike | null> {
    if (this.disposed) return null;
    if (this.current) return this.current;
    if (this.resolving) return await this.resolving;

    this.resolving = (async () => {
      try {
        const broker = await this.resolveBroker();
        this.current = broker;
        this.lastError = undefined;
        return broker;
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        return null;
      } finally {
        this.resolving = null;
      }
    })();

    return await this.resolving;
  }

  async ensureReady(options: EnsureReadyOptions = {}): Promise<void> {
    if (this.disposed) return;
    const broker = await this.resolve();
    if (!broker) return;
    try {
      await broker.ensureReady?.(options);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    // Only drop a broker that is structurally wrong for the current topology: a
    // primary that cannot hold the port. Proxies and promoted brokers report
    // brokerListening=false during every ordinary reconnect blip, and dropping
    // them there orphaned a broker that kept its heal loop running and could
    // still bind the port — two competing brokers in one process.
    const probe = this.observe(broker.probeConnectivity());
    if (probe.role === 'primary' && !probe.brokerListening) {
      this.current = null;
    }
  }

  probeConnectivity(): ProbeResult {
    if (this.disposed) {
      return {
        brokerReachable: false,
        brokerListening: false,
        bridgeConnected: false,
        startupError: 'browser broker was shut down with this pi session',
        url: this.url,
        bridgeSessionSerial: this.lastSeenBridgeSessionSerial,
      };
    }
    if (this.current) {
      return this.observe(this.current.probeConnectivity());
    }
    return {
      brokerReachable: false,
      brokerListening: false,
      bridgeConnected: false,
      startupError: this.lastError ?? 'browser broker has not been acquired in this process yet',
      url: this.url,
      bridgeSessionSerial: this.lastSeenBridgeSessionSerial,
    };
  }

  private observe(probe: ProbeResult): ProbeResult {
    if (typeof probe.bridgeSessionSerial === 'number') {
      this.lastSeenBridgeSessionSerial = probe.bridgeSessionSerial;
    }
    return probe;
  }

  async request(type: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<ResponseFrame> {
    if (this.disposed) {
      throw new Error('E_BRIDGE_DISCONNECTED');
    }
    const broker = await this.resolve();
    if (!broker) {
      throw new Error('E_BRIDGE_DISCONNECTED');
    }
    return await broker.request(type, params, options);
  }
}
