import { HttpClientError } from './http-client.error.js';
import { redactUrl } from '../utils/url.util.js';

/**
 * The per-attempt `timeout` elapsed. Interceptors see it for every attempt
 * that times out; the caller gets it when the last attempt does.
 */
export class HttpTimeoutError extends HttpClientError {
  /** The limit that elapsed. */
  readonly timeoutMs: number;

  constructor(init: {
    method: string;
    url: string;
    timeoutMs: number;
    cause?: unknown;
  }) {
    super(
      `${init.method} ${redactUrl(init.url)} timed out after ${init.timeoutMs}ms`,
      init,
    );
    this.timeoutMs = init.timeoutMs;
  }
}
