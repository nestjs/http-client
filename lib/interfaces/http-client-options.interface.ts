import type { HttpClientInterceptorLike } from './http-client-interceptor.interface.js';
import type { HttpHeadersInit } from './http-request.interface.js';
import type { HttpRetryOptions } from './http-retry-options.interface.js';
import type { Duration } from '../types/duration.type.js';

/**
 * An undici dispatcher (`Agent`, `ProxyAgent`, `MockAgent`, …). Typed by shape
 * so the package needs no undici types; a Node `http.Agent` is rejected.
 */
export interface HttpDispatcher {
  dispatch(options: object, handler: object): boolean;
}

/** Settings that `forRoot()`, a client and a single request can each set; the most specific wins. */
export interface HttpSharedOptions {
  headers?: HttpHeadersInit;
  /**
   * Per-attempt limit, e.g. `'5s'` or `5_000`: until the body is read, or
   * until the headers arrive for `stream`/`response`. `0` means none. Default none.
   */
  timeout?: Duration;
  /** A number is shorthand for `{ attempts }`; `false` makes a single attempt. */
  retry?: number | false | HttpRetryOptions;
  /** Throw `HttpResponseError` for non-2xx. Default `true`. */
  throwOnHttpError?: boolean;
  /**
   * How `fetch` handles 3xx responses. Default `follow`. A redirect to another
   * origin drops `authorization` and `cookie`, but not other headers, such as
   * an `x-api-key`.
   */
  redirect?: 'follow' | 'error' | 'manual';
  /** Connection pool, proxy or TLS settings (an undici `Agent` or `ProxyAgent`). */
  dispatcher?: HttpDispatcher;
}

export interface HttpClientOptions extends HttpSharedOptions {
  /**
   * Prefix for relative URLs, joined with exactly one `/`: an absolute http(s)
   * URL without credentials, query or fragment. An absolute request URL must
   * be on its origin.
   */
  baseUrl?: string | URL;
  /** Run in order, first = outermost. `forRoot()` interceptors run before these. */
  interceptors?: HttpClientInterceptorLike[];
  /** `fetch` implementation. Default `globalThis.fetch`, looked up on every request. */
  fetch?: typeof globalThis.fetch;
}

/** `HttpClientModule.forRoot()`: defaults for every client in the app. */
export interface HttpClientModuleOptions extends Omit<
  HttpClientOptions,
  'baseUrl'
> {}
