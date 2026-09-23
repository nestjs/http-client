import { Readable } from 'node:stream';
import {
  DEFAULT_RETRY,
  backoffDelay,
  isReplayableBody,
  mergeRetry,
  parseRetryAfter,
  resolveRetry,
  type RetryInput,
} from '../lib/retry.js';

const resolve = (...layers: RetryInput[]) =>
  resolveRetry(layers.reduce(mergeRetry, undefined));

describe('retry helpers', () => {
  it('parses Retry-After as seconds or HTTP-date', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:27:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });

  it('accepts the obsolete HTTP-date forms, and reads asctime as GMT', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    expect(parseRetryAfter('Wednesday, 21-Oct-26 07:28:10 GMT', now)).toBe(
      10_000,
    );
    expect(parseRetryAfter('Wed Oct 21 07:28:20 2026', now)).toBe(20_000);
    expect(parseRetryAfter('Wed Oct  1 07:28:00 2026', now)).toBe(0);
  });

  it('ignores a malformed Retry-After, so the backoff applies instead of an instant retry', () => {
    const now = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');
    // Date.parse() reads some of these as dates in the past, which would mean "retry now"
    for (const value of [
      '-1',
      '+5',
      '1e3',
      '0x10',
      '5, 10',
      'Wed, 21 Oct 2026',
      '10 Oct 2026 07:28:00',
    ]) {
      expect(parseRetryAfter(value, now), value).toBeUndefined();
    }
    // Fractions aren't valid delay-seconds, but their meaning is clear
    expect(parseRetryAfter('1.5', now)).toBe(1_500);
    expect(parseRetryAfter(' 30 ', now)).toBe(30_000);
    expect(parseRetryAfter('99999999999999999999', now)).toBeGreaterThan(
      30_000,
    );
  });

  it('defaults to exponential backoff with full jitter: 200 ms, factor 2, capped at 30 s', () => {
    const retry = resolveRetry(undefined)!;
    expect(retry).toMatchObject({
      attempts: 3,
      methods: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'],
      statusCodes: [408, 429, 500, 502, 503, 504],
      backoff: { delay: 200, factor: 2, maxDelay: 30_000, jitter: 'full' },
      maxRetryAfter: 30_000,
    });
    expect(backoffDelay(retry, 1, undefined, () => 0.999)).toBe(199);
    expect(backoffDelay(retry, 3, undefined, () => 0.999)).toBe(799);
    expect(backoffDelay(retry, 20, undefined, () => 0.999)).toBe(29_970);
    expect(backoffDelay(retry, 3, undefined, () => 0)).toBe(0);
  });

  it('computes factor, maxDelay and every jitter mode from Durations', () => {
    const backoff = (
      jitter: 'full' | 'equal' | 'none',
      attempt: number,
      random = 0.5,
    ) =>
      backoffDelay(
        resolveRetry({
          backoff: { delay: '1s', factor: 3, maxDelay: '5s', jitter },
        })!,
        attempt,
        undefined,
        () => random,
      );
    expect([1, 2, 3].map((n) => backoff('none', n))).toEqual([
      1_000, 3_000, 5_000,
    ]);
    expect(backoff('full', 2)).toBe(1_500); // random in [0, 3000]
    expect(backoff('equal', 2, 0)).toBe(1_500); // floor of half
    expect(backoff('equal', 2, 0.999)).toBe(2_998);
    // factor 1 = constant
    const constant = resolveRetry({
      backoff: { delay: 250, factor: 1, jitter: 'none' },
    })!;
    expect([1, 5].map((n) => backoffDelay(constant, n, undefined))).toEqual([
      250, 250,
    ]);
  });

  it('takes the wait from a backoff function, given the attempt that failed and its error', () => {
    const error = new Error('boom');
    const fn = vi.fn((attempt: number) => `${attempt}s` as const);
    const retry = resolveRetry({ backoff: fn })!;
    expect(backoffDelay(retry, 2, error)).toBe(2_000);
    expect(fn).toHaveBeenCalledWith(2, error);
    // A Retry-After is still capped by the default maxDelay
    expect(retry.maxRetryAfter).toBe(30_000);
  });

  it('layers retry options on the defaults; false disables, a number means attempts', () => {
    expect(resolve()).toMatchObject({ attempts: DEFAULT_RETRY.attempts });
    expect(resolve(false)).toBeUndefined();
    expect(resolve(1)).toBeUndefined();
    expect(resolve(0)).toBeUndefined();
    expect(resolve(3)?.attempts).toBe(3);
    expect(resolve(3, false)).toBeUndefined();
    // A later layer turns retries back on, starting from the defaults
    expect(
      resolve({ attempts: 5 }, false, { backoff: { delay: 1 } }),
    ).toMatchObject({
      attempts: 3,
      backoff: { delay: 1 },
    });
    expect(resolve({ attempts: 4 }, { backoff: { delay: 5 } })).toMatchObject({
      attempts: 4,
      backoff: { delay: 5 },
    });
    expect(resolve(4, { statusCodes: [503] })).toMatchObject({
      attempts: 4,
      statusCodes: [503],
    });
    expect(resolve({ methods: ['post'] })?.methods).toEqual(['POST']);
  });

  it('merges backoff objects field by field across layers; a function replaces', () => {
    const fn = () => 10;
    expect(
      resolve(
        { backoff: { delay: 500, jitter: 'none' } },
        { backoff: { maxDelay: '1s' } },
      )?.backoff,
    ).toEqual({ delay: 500, factor: 2, maxDelay: 1_000, jitter: 'none' });
    expect(resolve({ backoff: { delay: 500 } }, { backoff: fn })?.backoff).toBe(
      fn,
    );
    expect(
      resolve({ backoff: fn }, { backoff: { delay: 7 } })?.backoff,
    ).toMatchObject({
      delay: 7,
      factor: 2,
    });
    // maxDelay also caps the Retry-After the client is willing to wait for
    expect(resolve({ backoff: { maxDelay: '2s' } })?.maxRetryAfter).toBe(2_000);
  });

  it('rejects an invalid duration with a message naming the option', () => {
    expect(() => resolveRetry({ backoff: { delay: '5 s' as '5s' } })).toThrow(
      'HttpClient `retry.backoff.delay`: Invalid duration "5 s"',
    );
    expect(() => resolveRetry({ backoff: { maxDelay: -1 } })).toThrow(
      /retry\.backoff\.maxDelay/,
    );
    // Longer than setTimeout can wait: the retry would fire at once
    expect(() => resolveRetry({ backoff: { maxDelay: '4w' } })).toThrow(
      'HttpClient `retry.backoff.maxDelay`: "4w" is longer than a timer can wait (about 24.8 days)',
    );
  });

  it('treats stream bodies as not replayable', () => {
    expect(isReplayableBody('x')).toBe(true);
    expect(isReplayableBody(new URLSearchParams('a=1'))).toBe(true);
    expect(isReplayableBody(new Blob(['x']))).toBe(true);
    expect(isReplayableBody(Readable.from(['x']))).toBe(false);
    expect(isReplayableBody(new ReadableStream())).toBe(false);
  });
});
