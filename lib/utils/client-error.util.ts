import { HttpClientError } from '../errors/http-client.error.js';
import { HttpNetworkError } from '../errors/http-network.error.js';
import { HttpTimeoutError } from '../errors/http-timeout.error.js';
import type { HttpRequest } from '../interfaces/http-request.interface.js';
import type { Timer } from './timers.util.js';

/**
 * A failure of one attempt as the caller sees it: the client's own errors as
 * they are, the caller's abort as its reason, the attempt's timer as an
 * `HttpTimeoutError`, and anything else as `otherwise` makes it.
 */
export function toClientError(
  error: unknown,
  request: HttpRequest,
  timer: Timer | undefined,
  timeoutMs: number | undefined,
  userSignal: AbortSignal | undefined,
  otherwise: (error: unknown) => unknown = (error) => error,
): unknown {
  if (error instanceof HttpClientError) return error;
  if (userSignal?.aborted && error === userSignal.reason) return error;
  if (timer?.signal.aborted) {
    return new HttpTimeoutError({
      method: request.method,
      url: request.url.href,
      timeoutMs: timeoutMs!,
      cause: error,
    });
  }
  if (userSignal?.aborted) return userSignal.reason;
  return otherwise(error);
}

/** Reading the body failed: past the checks above, that is the connection (e.g. a reset). */
export function toBodyError(
  error: unknown,
  request: HttpRequest,
  timer: Timer | undefined,
  timeoutMs: number | undefined,
  userSignal: AbortSignal | undefined,
): unknown {
  return toClientError(
    error,
    request,
    timer,
    timeoutMs,
    userSignal,
    (cause) =>
      new HttpNetworkError({
        method: request.method,
        url: request.url.href,
        cause: (cause as { cause?: unknown })?.cause ?? cause,
      }),
  );
}
