import { toMs, type Duration } from './duration.js';
import type {
  HttpBackoffOptions,
  HttpRetryOptions,
} from './http-client.options.js';

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

const DAY = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
const WEEKDAY = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)';
const MONTH = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
const TIME = '\\d{2}:\\d{2}:\\d{2}';
/** The three HTTP-date forms (RFC 9110 §5.6.7): IMF-fixdate, RFC 850, asctime. */
const HTTP_DATE = [
  new RegExp(`^${DAY}, \\d{2} ${MONTH} \\d{4} ${TIME} GMT$`, 'i'),
  new RegExp(`^${WEEKDAY}, \\d{2}-${MONTH}-\\d{2} ${TIME} GMT$`, 'i'),
  new RegExp(`^${DAY} ${MONTH} [ \\d]\\d ${TIME} \\d{4}$`, 'i'),
];

/**
 * `Retry-After` as delay-seconds or an HTTP-date → ms; `undefined` when absent
 * or malformed (the backoff applies then). A date in the past is 0.
 */
export function parseRetryAfter(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  // Delay-seconds; fractions are tolerated, signs and exponents aren't
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const form = HTTP_DATE.findIndex((pattern) => pattern.test(trimmed));
  if (form === -1) return undefined;
  // asctime has no zone; HTTP-dates are always GMT
  const date = Date.parse(form === 2 ? `${trimmed} GMT` : trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Stream bodies are consumed by the first attempt and can't be replayed. */
export function isReplayableBody(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (
    typeof body === 'string' ||
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer
  )
    return true;
  if (body instanceof ReadableStream) return false;
  return (
    typeof (body as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] !== 'function'
  );
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The longest delay `setTimeout` supports (about 24.8 days); longer ones fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** `toMs()` with the option's name in the error, e.g. "HttpClient `timeout`: Invalid duration …". */
export function durationOption(value: Duration, option: string): number {
  let ms: number;
  try {
    ms = toMs(value);
  } catch (error) {
    throw new TypeError(
      `HttpClient \`${option}\`: ${(error as Error).message}`,
    );
  }
  if (ms > MAX_TIMER_MS) {
    throw new TypeError(
      `HttpClient \`${option}\`: ${JSON.stringify(value)} is longer than a timer can wait (about 24.8 days)`,
    );
  }
  return ms;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}
