import type { Type } from '@nestjs/common';
import type { Readable } from 'node:stream';
import type { Duration } from './duration.js';

/** What the global `fetch` accepts as a body, without depending on the DOM lib. */
type FetchBody = NonNullable<RequestInit['body']>;

/** Anything `fetch` accepts as a body, plus Node streams / async iterables. */
export type HttpRequestBody =
  FetchBody | Readable | AsyncIterable<Uint8Array> | null | undefined;

export type HeaderValue =
  string | number | readonly string[] | null | undefined;

/**
 * Header input. `null` removes a header set at a lower level
 * (`forRoot()` → client → request), e.g. `{ authorization: null }`.
 */
export type HttpHeadersInit = Headers | Record<string, HeaderValue>;

export type QueryValue = string | number | boolean | Date | null | undefined;

/** Arrays repeat the key (`?tag=a&tag=b`); `null`/`undefined` are skipped. */
export type HttpQuery =
  URLSearchParams | Record<string, QueryValue | readonly QueryValue[]>;

/**
 * - `auto` (default): JSON when the content type says so, otherwise text;
 *   `undefined` for empty bodies, 204/205/304 and HEAD.
 * - `json` / `text` / `arrayBuffer`: read the body as that.
 * - Invalid JSON rejects with `HttpParseError`.
 * - `stream`: a Node `Readable` (body left unread; the timeout stops at headers).
 * - `response`: the raw web `Response` (body left unread).
 */
export type HttpResponseType =
  'auto' | 'json' | 'text' | 'arrayBuffer' | 'stream' | 'response';

export interface HttpBackoffOptions {
  /** Wait before the first retry. Default 200 ms. */
  delay?: Duration;
  /** Growth per retry; `1` = constant. Default 2. */
  factor?: number;
  /**
   * Cap for a single wait. A `Retry-After` asking for longer is not waited
   * out: the response is returned (or thrown) at once. Default 30 s.
   */
  maxDelay?: Duration;
  /** Default `full`: a random wait in [0, computed], so callers don't retry in lockstep. */
  jitter?: 'full' | 'equal' | 'none';
}

/**
 * Retries are on by default: 3 attempts for idempotent methods, after
 * connection errors, per-attempt timeouts and 408/429/500/502/503/504.
 * Every field replaces its default; unset fields keep it.
 */
export interface HttpRetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /**
   * Wait between attempts. A function gets the attempt that just failed
   * (1-based) and its error. A `Retry-After` header replaces it either way.
   */
  backoff?:
    HttpBackoffOptions | ((attempt: number, error: unknown) => Duration);
  /**
   * Consulted for a failure the client would retry (see `methods` and
   * `statusCodes`); return `false` to stop. `error` is the
   * `HttpResponseError` (body read), `HttpNetworkError` or `HttpTimeoutError`
   * of the attempt that just failed.
   */
  retryIf?: (error: unknown, attempt: number) => boolean;
  /**
   * Methods that are retried. Default GET, HEAD, OPTIONS, PUT, DELETE
   * (idempotent by RFC 9110). Replaces the default list.
   */
  methods?: string[];
  /** Response statuses that are retried. Default 408, 429, 500, 502, 503, 504. */
  statusCodes?: number[];
}

/** Request as seen by interceptors. Mutable; or pass a modified copy to `next`. */
export interface HttpRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: HttpRequestBody;
  /** Combined user signal + per-attempt timeout. */
  signal: AbortSignal;
  /** 1-based attempt number (interceptors run once per attempt). */
  attempt: number;
  /** Free-form bag carried from the request's `context` option, for interceptors. */
  context: Record<string, unknown>;
}

export type HttpHandler = (request: HttpRequest) => Promise<Response>;

export type HttpClientInterceptorFn = (
  request: HttpRequest,
  next: HttpHandler,
) => Promise<Response>;

/** Class form; resolved from the DI container when registered as a type. */
export interface HttpClientInterceptor {
  intercept(request: HttpRequest, next: HttpHandler): Promise<Response>;
}

export type HttpClientInterceptorLike =
  HttpClientInterceptorFn | HttpClientInterceptor | Type<HttpClientInterceptor>;

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

export interface HttpRequestOptions extends HttpSharedOptions {
  /** Only used by `request()`; the verb methods set it. Default GET. */
  method?: string;
  query?: HttpQuery;
  /**
   * Fills `/:name` segments of the URL, URI-encoded. Every key must match a
   * segment, and a value can't be empty, `.` or `..`.
   */
  params?: Record<string, string | number>;
  /** Serialized with `JSON.stringify`; sets `content-type: application/json`. */
  json?: unknown;
  /** Raw body, passed to fetch as is. Mutually exclusive with `json`. */
  body?: HttpRequestBody;
  responseType?: HttpResponseType;
  signal?: AbortSignal;
  context?: Record<string, unknown>;
}

export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  data: T;
  /** Final URL, after redirects. */
  url: string;
  /** The request of the last attempt, after interceptors. */
  request: HttpRequest;
}
