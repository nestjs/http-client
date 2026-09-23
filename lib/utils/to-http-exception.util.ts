import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import { HttpClientError } from '../errors/http-client.error.js';
import { HttpResponseError } from '../errors/http-response.error.js';
import { HttpTimeoutError } from '../errors/http-timeout.error.js';

export interface ToHttpExceptionOptions {
  /**
   * Upstream statuses to pass through with the upstream body (`true` = all).
   * Default none: an upstream failure is *our* 502, and the upstream body
   * (which may describe internals) is not sent to the caller.
   */
  forward?: boolean | number[];
  /**
   * Log the failure (`Logger.error`, context `HttpClient`) when it becomes a
   * 5xx. Default `true`: Nest's exception filter never logs an
   * `HttpException`, so the 502/504 would otherwise go unrecorded.
   */
  log?: boolean;
}

const logger = new Logger('HttpClient');

/**
 * The exception a handler should throw for a failed upstream call:
 * `HttpResponseError` → 502 (or the upstream status and body, when
 * forwarded), `HttpTimeoutError` and an `AbortSignal.timeout()` deadline → 504,
 * `HttpNetworkError` and `HttpParseError` → 502. The original error is the
 * `cause`, and mappings to a 5xx are logged unless `log: false`.
 *
 * Any other error, including an `HttpException`, is returned unchanged, so
 * Nest's exception filters (or another package's) handle it as usual.
 */
export function toHttpException(
  error: HttpClientError,
  options?: ToHttpExceptionOptions,
): HttpException;

export function toHttpException(
  error: unknown,
  options?: ToHttpExceptionOptions,
): unknown;

export function toHttpException(
  error: unknown,
  options: ToHttpExceptionOptions = {},
): unknown {
  const exception = map(error, options.forward);
  if (!exception) return error;
  if (options.log !== false && exception.getStatus() >= 500) {
    // The message names method, URL (query values masked) and status or cause. The reason
    // phrase comes from the status, not the exception's message, which differs across Nest
    // versions ("Bad Gateway" in v12, "Bad Gateway Exception" in v11).
    const status = exception.getStatus();
    const answer =
      `answering ${status} ${STATUS_CODES[status] ?? ''}`.trimEnd();
    logger.error(`${(error as Error).message}; ${answer}`);
  }
  return exception;
}

export function map(
  error: unknown,
  forward: ToHttpExceptionOptions['forward'],
): HttpException | undefined {
  if (error instanceof HttpResponseError) {
    if (
      forward === true ||
      (Array.isArray(forward) && forward.includes(error.status))
    ) {
      return new HttpException(error.body ?? error.statusText, error.status, {
        cause: error,
      });
    }
    return new BadGatewayException(undefined, { cause: error });
  }
  if (error instanceof HttpTimeoutError || isDeadline(error)) {
    return new GatewayTimeoutException(undefined, { cause: error });
  }
  if (error instanceof HttpClientError) {
    return new BadGatewayException(undefined, { cause: error });
  }
  return undefined;
}

/** A deadline passed as `signal: AbortSignal.timeout(ms)` rejects with this. */
function isDeadline(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'TimeoutError';
}
