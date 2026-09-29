import type { BrokerLogger } from './server.ts';

export type BrowserHealthUi = {
  notify?: (message: string, type?: 'info' | 'warning' | 'error') => void;
  setStatus?: (key: string, text: string | undefined) => void;
};

// Broker logs describe individual attempts, not the outcome of recovery. Never
// forward them (or Error objects) into pi's notifications or runtime console.
export const quietBrokerLogger: BrokerLogger = { info() {}, warn() {}, error() {} };
export const RECOVERY_GRACE_MS = 60_000;

/** One reporter per session, retained across broker replacements. */
export class BrowserHealthReporter {
  private disconnectedSince: number | null = null;
  private warned = false;
  private status: string | undefined;
  private disposed = false;

  private readonly ui?: BrowserHealthUi;

  constructor(ui?: BrowserHealthUi) {
    this.ui = ui;
  }

  observe(connected: boolean, now = Date.now()): void {
    if (this.disposed) return;
    if (connected) {
      this.disconnectedSince = null;
      this.warned = false;
      this.setStatus('browser: connected');
      return;
    }
    this.disconnectedSince ??= now;
    const expired = now - this.disconnectedSince >= RECOVERY_GRACE_MS;
    this.setStatus(expired ? 'browser: disconnected' : 'browser: recovering');
    if (expired && !this.warned) {
      this.warned = true;
      this.ui?.notify?.('Browser unavailable. Check Chrome and the Browser Agent extension; retrying quietly.', 'warning');
    }
  }

  /** Time spent suspended is not a failed recovery attempt. Keep the warning
   *  latch, but give an unfinished recovery a fresh grace period on resume. */
  resume(): void {
    this.disconnectedSince = null;
  }

  dispose(): void {
    this.disposed = true;
    this.ui?.setStatus?.('browser-bridge', undefined);
  }

  private setStatus(status: string): void {
    if (this.status === status) return;
    this.status = status;
    this.ui?.setStatus?.('browser-bridge', status);
  }
}
