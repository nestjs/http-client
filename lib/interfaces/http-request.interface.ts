import { Readable } from 'node:stream';
import type { HttpSharedOptions } from './http-client-options.interface.js';

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
