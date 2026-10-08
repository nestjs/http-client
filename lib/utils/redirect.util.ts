import { isReplayableBody } from './request-body.util.js';
import { discard } from './response.util.js';
import { assertSendableUrl } from './url.util.js';

/** fetch's own limit. */
const MAX_REDIRECTS = 20;

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/** Dropped with the body when a redirect turns the request into a GET (fetch spec + content-length, as undici). */
const REQUEST_BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
  'content-length',
];

/** The init `HttpClient.fetch()` builds; `dispatcher` is typed by shape there, so it is `object` here. */
type RedirectInit = object & {
  method?: string;
  headers?: RequestInit['headers'];
  body?: unknown;
};

/**
 * Follows redirects like `redirect: 'follow'`, but only within `origin`:
 * fetch itself would follow a redirect anywhere and keep every header except
 * `authorization` and `cookie`, which would send a client's other credentials
 * (an `x-api-key`, what an interceptor added) and a 307/308 body to another
 * host. Throws a `TypeError` (as fetch does for `redirect: 'error'`) for a
 * cross-origin redirect, too many of them, or a stream body that would have
 * to be sent again.
 */
export async function fetchWithinOrigin(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  init: RedirectInit,
  origin: string,
): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(current, {
      ...init,
      redirect: 'manual',
    } as RequestInit);
    const location = response.headers.get('location');
    if (!REDIRECT_STATUS.has(response.status) || location === null)
      return response;
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      discard(response);
      throw new TypeError('invalid redirect location');
    }
    if (next.origin !== origin) {
      discard(response);
      throw new TypeError(
        `redirect to another origin (${next.origin}) refused: the client only sends to ${origin}`,
      );
    }
    if (hop >= MAX_REDIRECTS) {
      discard(response);
      throw new TypeError('too many redirects');
    }
    try {
      // fetch rejects a URL with credentials with a message that quotes them
      assertSendableUrl(next);
    } catch (error) {
      discard(response);
      throw error;
    }
    // The fetch spec's rules for which redirects turn the request into a GET
    const method = (init.method ?? 'GET').toUpperCase();
    const toGet =
      (response.status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) &&
        method === 'POST');
    if (toGet) {
      const headers = new Headers(init.headers);
      for (const name of REQUEST_BODY_HEADERS) headers.delete(name);
      init = { ...init, method: 'GET', body: undefined, headers };
    } else if (!isReplayableBody(init.body)) {
      discard(response);
      throw new TypeError(
        `redirect (${response.status}) would resend a stream body, which can be sent only once`,
      );
    }
    discard(response);
    current = next;
  }
}
