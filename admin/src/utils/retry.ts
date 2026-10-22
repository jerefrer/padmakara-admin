/**
 * Retry with exponential backoff for the audio upload pipeline.
 *
 * Only *transient* failures are retried: the connection dropped, the request
 * timed out, or the server answered 408 / 429 / 5xx. Anything else (a 4xx,
 * a cancellation) fails immediately — retrying it would only hide the real
 * problem and delay the error the admin needs to see.
 */

/** An HTTP response that came back with a non-2xx status. */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

/** The request never got a response (offline, DNS, connection reset…). */
export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

/** The admin cancelled the upload. Never retried. */
export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "UploadCancelledError";
  }
}

export function isTransientError(err: unknown): boolean {
  if (err instanceof UploadCancelledError) return false;
  if (err instanceof NetworkError) return true;
  // fetch() rejects with a TypeError when the network is unreachable.
  if (err instanceof TypeError) return true;
  if (err instanceof HttpStatusError) {
    return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
  }
  return false;
}

export interface RetryOptions {
  /** Retries after the first attempt (so `retries: 3` means up to 4 tries). */
  retries?: number;
  /** Delay before the first retry; doubles on each subsequent one. */
  baseDelayMs?: number;
  /** Upper bound for a single delay. */
  maxDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
  /** Checked before every attempt and after every wait. */
  signal?: { cancelled: boolean };
  /** Called before waiting for retry number `attempt` (1-based). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: Required<Pick<RetryOptions, "retries" | "baseDelayMs" | "maxDelayMs">> = {
  retries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 15000,
};

export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` until it succeeds, retrying transient errors with exponential
 * backoff. `fn` receives the 0-based attempt number.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? DEFAULT_RETRY.retries;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const isRetryable = options.isRetryable ?? isTransientError;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    if (options.signal?.cancelled) throw new UploadCancelledError();
    try {
      return await fn(attempt);
    } catch (err) {
      if (options.signal?.cancelled) throw new UploadCancelledError();
      if (attempt >= retries || !isRetryable(err)) throw err;
      const delayMs = backoffDelay(attempt + 1, baseDelayMs, maxDelayMs);
      options.onRetry?.(attempt + 1, err, delayMs);
      await sleep(delayMs);
    }
  }
}
