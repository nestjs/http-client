import type { Duration } from '../types/duration.type.js';

export interface HttpBackoffOptions {
  /** Wait before the first retry. Default 200 ms. */
  delay?: Duration;
  /** Growth per retry; `1` = constant. Default 2. */
  factor?: number;
  /**
   * Cap for a single wait. A `Retry-After` asking for longer is not waited
   * out: the response is returned (or thrown) at once. Default 30 s.
   */
  maxDelay?: Duration;
  /** Default `full`: a random wait in [0, computed], so callers don't retry in lockstep. */
  jitter?: 'full' | 'equal' | 'none';
}

/**
 * Retries are on by default: 3 attempts for idempotent methods, after
 * connection errors, per-attempt timeouts and 408/429/500/502/503/504.
 * Every field replaces its default; unset fields keep it.
 */
export interface HttpRetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /**
   * Wait between attempts. A function gets the attempt that just failed
   * (1-based) and its error. A `Retry-After` header replaces it either way.
   */
  backoff?:
    HttpBackoffOptions | ((attempt: number, error: unknown) => Duration);
  /**
   * Consulted for a failure the client would retry (see `methods` and
   * `statusCodes`); return `false` to stop. `error` is the
   * `HttpResponseError` (body read), `HttpNetworkError` or `HttpTimeoutError`
   * of the attempt that just failed.
   */
  retryIf?: (error: unknown, attempt: number) => boolean;
  /**
   * Methods that are retried. Default GET, HEAD, OPTIONS, PUT, DELETE
   * (idempotent by RFC 9110). Replaces the default list.
   */
  methods?: string[];
  /** Response statuses that are retried. Default 408, 429, 500, 502, 503, 504. */
  statusCodes?: number[];
}
