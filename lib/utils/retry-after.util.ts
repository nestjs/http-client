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
