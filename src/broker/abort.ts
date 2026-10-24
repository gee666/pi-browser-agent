/**
 * Cooperative cancellation for broker requests.
 *
 * pi hands every tool an `AbortSignal` (see `execute(toolCallId, params,
 * signal, ...)` in pi's extension API) and fires it when the user presses
 * Escape. Before this module nothing in this package listened to that signal,
 * so an aborted call stayed pending inside `broker.request()` until its own
 * timeout expired — up to 15s for browser_evaluate_js, 30s for browser_run_js
 * and longer for navigation waits. Escape looked like it did nothing.
 *
 * Everything here is host-side only: it releases pi immediately and drops the
 * pending request entry. Work already started inside the page keeps running
 * until the bridge grows a real cancel frame.
 */

export const ABORT_ERROR_CODE = 'E_ABORTED';

export interface AbortableOptions {
  /** Fired by pi when the user cancels the tool call (Escape). */
  signal?: AbortSignal;
}

export interface BrokerRequestOptions extends AbortableOptions {
  timeoutMs?: number;
}

/** Error surfaced to callers when a request is cancelled. Carries the same
 *  `code`/`message` shape the tool layer already uses for protocol errors. */
export class BrokerAbortError extends Error {
  readonly code = ABORT_ERROR_CODE;
  readonly details?: unknown;

  constructor(message = 'Request cancelled', details?: unknown) {
    super(message);
    this.name = 'BrokerAbortError';
    this.details = details;
  }
}

/** True for our own abort error and for the DOMException `AbortError` that
 *  `AbortSignal.throwIfAborted()` / stdlib APIs raise. */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return candidate.code === ABORT_ERROR_CODE || candidate.name === 'AbortError';
}

function describeReason(signal: AbortSignal | undefined): string | undefined {
  const reason = signal?.reason as unknown;
  if (reason === undefined || reason === null) return undefined;
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return reason.message;
  return undefined;
}

export function abortError(context: string, signal?: AbortSignal): BrokerAbortError {
  const reason = describeReason(signal);
  return new BrokerAbortError(
    reason ? `${context} was cancelled: ${reason}` : `${context} was cancelled`,
  );
}

/** Reject immediately when the caller is already gone, so we never open a
 *  socket request for a tool call pi has stopped waiting for. */
export function throwIfAborted(signal: AbortSignal | undefined, context: string): void {
  if (signal?.aborted) {
    throw abortError(context, signal);
  }
}

/**
 * Attach an abort listener and return a disposer. Always call the disposer once
 * the awaited work settles: a listener left on a long-lived session signal
 * keeps the closure (and its promise) alive for the rest of the session.
 */
export function onAbort(signal: AbortSignal | undefined, listener: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    listener();
    return () => {};
  }
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}

/**
 * Sleep that wakes early on abort. Returns `false` when it was cut short, so
 * polling loops can exit instead of burning their full budget after Escape.
 */
export async function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (ms <= 0) return !signal?.aborted;

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      release();
      resolve(completed);
    };
    const timer = setTimeout(() => finish(true), ms);
    timer.unref?.();
    const release = onAbort(signal, () => finish(false));
  });
}
