import type { Duration } from '../types/duration.type.js';
import { MAX_TIMER_MS } from './timers.util.js';

/**
 * `toMs()` with the option's name in the error, e.g. "HttpClient `timeout`:
 * Invalid duration …". `cause`, when given, becomes the TypeError's `cause`.
 */
export function durationOption(
  value: Duration,
  option: string,
  cause?: unknown,
): number {
  const options = cause === undefined ? undefined : { cause };
  let ms: number;
  try {
    ms = toMs(value);
  } catch (error) {
    throw new TypeError(
      `HttpClient \`${option}\`: ${(error as Error).message}`,
      options,
    );
  }
  if (ms > MAX_TIMER_MS) {
    throw new TypeError(
      `HttpClient \`${option}\`: ${JSON.stringify(value)} is longer than a timer can wait (about 24.8 days)`,
      options,
    );
  }
  return ms;
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

export function toMs(duration: Duration): number {
  if (typeof duration === 'number') {
    if (!Number.isFinite(duration) || duration < 0) {
      throw new TypeError(
        `Invalid duration ${duration}. Use a non-negative number of milliseconds.`,
      );
    }
    return duration;
  }
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(duration);
  if (!match) {
    throw new TypeError(
      `Invalid duration "${duration}". Use milliseconds or a string such as "15m" or "3d".`,
    );
  }
  return Math.round(Number(match[1]) * UNITS[match[2]]);
}
