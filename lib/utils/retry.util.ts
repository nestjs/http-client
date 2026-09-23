import { HttpNetworkError } from '../errors/http-network.error.js';
import { HttpTimeoutError } from '../errors/http-timeout.error.js';
import type { HttpRequest } from '../interfaces/http-request.interface.js';
import type {
  HttpBackoffOptions,
  HttpRetryOptions,
} from '../interfaces/http-retry-options.interface.js';
import type { Duration } from '../types/duration.type.js';
import { durationOption } from './duration.util.js';
import { toResponseError } from './response.util.js';
import { parseRetryAfter } from './retry-after.util.js';

/**
 * Asks `retryIf`, which may only narrow the defaults. What it throws
 * propagates, like a bug anywhere else; a Promise is refused, since it would
 * always count as `true`.
 */
export function shouldRetry(
  retry: ResolvedRetry,
  error: unknown,
  attempt: number,
): boolean {
  if (!retry.retryIf) return true;
  const verdict: unknown = retry.retryIf(error, attempt);
  if (
    typeof (verdict as PromiseLike<unknown> | undefined)?.then === 'function'
  ) {
    (verdict as Promise<unknown>).then(undefined, () => undefined);
    throw new TypeError(
      'HttpClient `retry.retryIf` must return a boolean, not a Promise',
    );
  }
  return !!verdict;
}

/**
 * The wait before retrying a response with a retryable status, or `undefined`
 * to stop. `Retry-After` replaces the backoff, and one longer than
 * `maxDelay` is not waited out.
 */
export async function retryDelay(
  retry: ResolvedRetry,
  response: Response,
  request: HttpRequest,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  // User code sees the failure as an HttpResponseError; read from a clone, so
  // the response can still be returned or thrown when there is no retry.
  const error =
    retry.retryIf || typeof retry.backoff === 'function'
      ? await toResponseError(response.clone(), request, signal)
      : undefined;
  if (retry.retryIf && !shouldRetry(retry, error, attempt)) return undefined;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter !== undefined)
    return retryAfter <= retry.maxRetryAfter ? retryAfter : undefined;
  return backoffDelay(retry, attempt, error);
}

/**
 * Connection-level failures and timeouts. A network error without a `code`
 * (a redirect that `redirect: 'error'` refused, too many redirects) fails the
 * same way on every attempt.
 */
export function isTransient(error: unknown): boolean {
  if (error instanceof HttpTimeoutError) return true;
  return (
    error instanceof HttpNetworkError &&
    typeof (error.cause as { code?: unknown } | undefined)?.code === 'string'
  );
}

export type RetryInput = number | false | HttpRetryOptions | undefined;

type BackoffFn = (attempt: number, error: unknown) => Duration;

interface ResolvedBackoff {
  delay: number;
  factor: number;
  maxDelay: number;
  jitter: 'full' | 'equal' | 'none';
}

export interface ResolvedRetry {
  attempts: number;
  methods: string[];
  statusCodes: number[];
  backoff: ResolvedBackoff | BackoffFn;
  /** Longest wait a `Retry-After` may ask for (`backoff.maxDelay`, or the default). */
  maxRetryAfter: number;
  retryIf?: (error: unknown, attempt: number) => boolean;
}

const DEFAULT_BACKOFF: ResolvedBackoff = {
  delay: 200,
  factor: 2,
  maxDelay: 30_000,
  jitter: 'full',
};

export const DEFAULT_RETRY = {
  attempts: 3,
  methods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'],
  statusCodes: [408, 429, 500, 502, 503, 504],
  backoff: DEFAULT_BACKOFF,
} as const;

/**
 * Layers retry settings (`forRoot()` → client → request). `false` turns
 * retries off; a later layer can turn them back on, starting from the
 * defaults. A number is shorthand for `{ attempts }`. `backoff` objects merge
 * field by field; a function replaces whatever was there.
 */
export function mergeRetry(base: RetryInput, layer: RetryInput): RetryInput {
  if (layer === undefined) return base;
  if (layer === false) return false;
  const previous: HttpRetryOptions =
    typeof base === 'number' ? { attempts: base } : base || {};
  const next: HttpRetryOptions =
    typeof layer === 'number' ? { attempts: layer } : layer;
  const merged: HttpRetryOptions = { ...previous, ...definedOnly(next) };
  const backoff = mergeBackoff(previous.backoff, next.backoff);
  if (backoff !== undefined) merged.backoff = backoff;
  return merged;
}

function mergeBackoff(
  base: HttpRetryOptions['backoff'],
  layer: HttpRetryOptions['backoff'],
): HttpRetryOptions['backoff'] {
  if (layer === undefined) return base;
  if (typeof layer === 'function' || typeof base !== 'object') return layer;
  return { ...base, ...definedOnly(layer) };
}

/**
 * Applies the defaults. `undefined` means a single attempt. Throws a
 * `TypeError` naming the option for an invalid duration, so a bad client
 * config fails when the client is created.
 */
export function resolveRetry(input: RetryInput): ResolvedRetry | undefined {
  if (input === false) return undefined;
  const options: HttpRetryOptions =
    typeof input === 'number' ? { attempts: input } : (input ?? {});
  const backoff =
    typeof options.backoff === 'function'
      ? options.backoff
      : resolveBackoff(options.backoff);
  const attempts = options.attempts ?? DEFAULT_RETRY.attempts;
  if (!(attempts > 1)) return undefined;
  return {
    attempts,
    methods: (options.methods ?? DEFAULT_RETRY.methods).map((method) =>
      method.toUpperCase(),
    ),
    statusCodes: [...(options.statusCodes ?? DEFAULT_RETRY.statusCodes)],
    backoff,
    maxRetryAfter:
      typeof backoff === 'function'
        ? DEFAULT_BACKOFF.maxDelay
        : backoff.maxDelay,
    retryIf: options.retryIf,
  };
}

function resolveBackoff(options: HttpBackoffOptions = {}): ResolvedBackoff {
  return {
    delay:
      options.delay === undefined
        ? DEFAULT_BACKOFF.delay
        : durationOption(options.delay, 'retry.backoff.delay'),
    factor: options.factor ?? DEFAULT_BACKOFF.factor,
    maxDelay:
      options.maxDelay === undefined
        ? DEFAULT_BACKOFF.maxDelay
        : durationOption(options.maxDelay, 'retry.backoff.maxDelay'),
    jitter: options.jitter ?? DEFAULT_BACKOFF.jitter,
  };
}

/**
 * The wait after attempt `attempt` (1-based) failed with `error`:
 * `min(maxDelay, delay * factor^(attempt-1))`, jittered. `full` picks a random
 * wait in [0, d], `equal` in [d/2, d], `none` waits exactly d.
 */
export function backoffDelay(
  retry: ResolvedRetry,
  attempt: number,
  error: unknown,
  random: () => number = Math.random,
): number {
  if (typeof retry.backoff === 'function') {
    return durationOption(retry.backoff(attempt, error), 'retry.backoff()');
  }
  const { delay, factor, maxDelay, jitter } = retry.backoff;
  const ceiling = Math.min(maxDelay, delay * factor ** (attempt - 1));
  switch (jitter) {
    case 'none':
      return Math.floor(ceiling);
    case 'equal':
      return Math.floor(ceiling / 2 + (random() * ceiling) / 2);
    default:
      return Math.floor(random() * ceiling);
  }
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
