import type { HttpQuery, QueryValue } from './http-client.options.js';

const ABSOLUTE = /^[a-z][a-z\d+\-.]*:/i;

/** `:name` at the start of a path segment; `/v1/items:batchGet` and ports don't match. */
const PLACEHOLDER = /(?<=\/):([A-Za-z_]\w*)/g;

/**
 * Replaces `/:name` segments with URI-encoded values. Throws on a missing
 * value, and on a key that matches no segment: axios calls the query string
 * `params`, and silently dropping it would send the request without it.
 */
export function applyPathParams(
  path: string,
  params?: Record<string, string | number>,
): string {
  if (!params) return path;
  const used = new Set<string>();
  const result = path.replace(PLACEHOLDER, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      throw new TypeError(`Missing path parameter "${name}" for "${path}"`);
    }
    used.add(name);
    return encodeSegment(name, String(value));
  });
  const unused = Object.keys(params).filter((name) => !used.has(name));
  if (unused.length > 0) {
    throw new TypeError(
      `No ":${unused[0]}" segment in "${path}" for path parameter "${unused[0]}". ` +
        'Query-string values go in `query`.',
    );
  }
  return result;
}

/**
 * URL parsers resolve `.` and `..` segments, even percent-encoded, so such a
 * value would move the request to another endpoint (`/invoices/..` is `/`),
 * and an empty one would turn `/invoices/:id` into the collection.
 */
function encodeSegment(name: string, value: string): string {
  if (value === '' || value === '.' || value === '..') {
    throw new TypeError(
      `Path parameter "${name}" can't be ${value ? `"${value}"` : 'empty'}: ` +
        'it would change which endpoint the request goes to',
    );
  }
  try {
    return encodeURIComponent(value);
  } catch {
    throw new TypeError(`Path parameter "${name}" is not well-formed Unicode`);
  }
}

/**
 * Validates `baseUrl` when the client is created: an absolute http(s) URL,
 * without credentials, query or fragment (they would end up in the middle of
 * every request URL).
 */
export function parseBaseUrl(
  baseUrl: string | URL | undefined,
): URL | undefined {
  if (baseUrl === undefined) return undefined;
  const text = String(baseUrl);
  const fail = (problem: string) => {
    throw new TypeError(
      `HttpClient \`baseUrl\`: "${redactUrl(text)}" ${problem}`,
    );
  };
  let url: URL | undefined;
  try {
    url = new URL(text);
  } catch {
    fail(
      'is not an absolute URL. Include the scheme, e.g. "https://api.example.com".',
    );
  }
  checkUrl(url!, fail);
  if (url!.search || url!.hash || text.endsWith('?') || text.endsWith('#')) {
    fail(
      "can't have a query string or fragment. Pass query values per request in `query`, " +
        'or add them to every request in an interceptor (`request.url.searchParams`).',
    );
  }
  return url;
}

/**
 * Joins like axios, not like `new URL(path, base)`: `https://x/v1` + `/users`
 * is `https://x/v1/users`. An absolute URL is only allowed on the base URL's
 * origin, so a client's headers and interceptors (its credentials) never
 * reach another host; a client without a base URL takes any http(s) URL.
 */
export function resolveUrl(baseUrl: URL | undefined, path: string): URL {
  if (ABSOLUTE.test(path)) {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      throw new TypeError(`"${redactUrl(path)}" is not a valid URL`);
    }
    checkUrl(url, (problem) => {
      throw new TypeError(`"${redactUrl(path)}" ${problem}`);
    });
    if (baseUrl && url.origin !== baseUrl.origin) {
      throw new TypeError(
        `"${redactUrl(path)}" is not on the client's origin (${baseUrl.origin}). A client with a ` +
          '`baseUrl` only sends requests there, so its headers and interceptors never reach another ' +
          'host. Call other hosts with a client registered for them, or one without a `baseUrl`.',
      );
    }
    return url;
  }
  if (!baseUrl) {
    throw new TypeError(
      `"${redactUrl(path)}" is a relative URL, and the client has no \`baseUrl\`. ` +
        'Set one when registering the client, or pass an absolute URL.',
    );
  }
  const base = baseUrl.href.replace(/\/+$/, '');
  return new URL(path ? `${base}/${path.replace(/^\/+/, '')}` : base);
}

/**
 * Checked again right before fetch, for a URL an interceptor changed: fetch
 * rejects credentials with a message that quotes them.
 */
export function assertSendableUrl(url: URL): void {
  checkUrl(url, (problem) => {
    throw new TypeError(`"${redactUrl(url.href)}" ${problem}`);
  });
}

function checkUrl(url: URL, fail: (problem: string) => never): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`is not an http: or https: URL`);
  }
  if (url.username || url.password) {
    fail(
      'includes credentials, which fetch rejects. Send them in the `authorization` header.',
    );
  }
}

function stringify(value: QueryValue): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Appends to the URL's existing query; arrays repeat the key, nullish values are skipped. */
export function appendQuery(url: URL, query?: HttpQuery): URL {
  if (!query) return url;
  if (query instanceof URLSearchParams) {
    query.forEach((value, key) => url.searchParams.append(key, value));
    return url;
  }
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values as QueryValue[]) {
      if (value === undefined || value === null) continue;
      url.searchParams.append(key, stringify(value));
    }
  }
  return url;
}

/**
 * The URL as it appears in error messages: credentials and fragment dropped,
 * every query value masked (`?token=***`). Query strings often carry API keys
 * or personal data, and messages end up in logs.
 */
export function redactUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input.replace(/[?#][\s\S]*$/, '').replace(/\/\/[^/@]*@/, '//');
  }
  const query = url.search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((pair) =>
      pair.includes('=') ? `${pair.slice(0, pair.indexOf('='))}=***` : '***',
    )
    .join('&');
  return `${url.protocol}//${url.host}${url.pathname}${query ? `?${query}` : ''}`;
}
