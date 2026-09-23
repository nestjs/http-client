import { redactUrl } from './url.js';

/**
 * Base class for every failure the client produces itself. Errors thrown by
 * interceptors and a user abort (`signal.reason`) propagate unchanged.
 *
 * Messages and error objects end up in logs, so `message` names the URL
 * without credentials and with every query value masked (`?token=***`), and
 * the fields that can carry secrets or personal data (`url`, `headers`,
 * `body`) are non-enumerable: readable, but left out by `util.inspect`,
 * `JSON.stringify` and log serializers.
 */
export class HttpClientError extends Error {
  readonly method: string;
  /** The full URL, query included. */
  declare readonly url: string;

  constructor(
    message: string,
    init: { method: string; url: string; cause?: unknown },
  ) {
    super(message, 'cause' in init ? { cause: init.cause } : undefined);
    this.name = new.target.name;
    this.method = init.method;
    hidden(this, 'url', init.url);
  }
}

export interface HttpResponseErrorInit<TBody = unknown> {
  method: string;
  url: string;
  status: number;
  statusText?: string;
  headers?: Headers;
  body?: TBody;
}

/** The upstream answered with a non-2xx status (unless `throwOnHttpError: false`). */
export class HttpResponseError<TBody = unknown> extends HttpClientError {
  readonly status: number;
  readonly statusText: string;
  declare readonly headers: Headers;
  /** Parsed JSON when the response was JSON, otherwise text (or `undefined` when empty). */
  declare readonly body: TBody;

  constructor(init: HttpResponseErrorInit<TBody>) {
    const { method, url, status, statusText = '' } = init;
    // The body is deliberately not in the message: it may carry PII/tokens
    // and messages end up in logs.
    super(
      `${method} ${redactUrl(url)} failed with ${status}${statusText ? ` ${statusText}` : ''}`,
      {
        method,
        url,
      },
    );
    this.status = status;
    this.statusText = statusText;
    hidden(this, 'headers', init.headers ?? new Headers());
    hidden(this, 'body', init.body);
  }
}

/**
 * The response body isn't valid JSON, although its `content-type` says so
 * (or `responseType: 'json'` asked for it). `body` holds the raw text.
 */
export class HttpParseError extends HttpClientError {
  readonly status: number;
  readonly statusText: string;
  declare readonly headers: Headers;
  declare readonly body: string;

  constructor(init: HttpResponseErrorInit<string>) {
    const { method, url, status, statusText = '' } = init;
    super(
      `${method} ${redactUrl(url)} returned invalid JSON (${status}${statusText ? ` ${statusText}` : ''})`,
      { method, url },
    );
    this.status = status;
    this.statusText = statusText;
    hidden(this, 'headers', init.headers ?? new Headers());
    hidden(this, 'body', init.body ?? '');
  }
}

/**
 * The per-attempt `timeout` elapsed. Interceptors see it for every attempt
 * that times out; the caller gets it when the last attempt does.
 */
export class HttpTimeoutError extends HttpClientError {
  /** The limit that elapsed. */
  readonly timeoutMs: number;

  constructor(init: {
    method: string;
    url: string;
    timeoutMs: number;
    cause?: unknown;
  }) {
    super(
      `${init.method} ${redactUrl(init.url)} timed out after ${init.timeoutMs}ms`,
      init,
    );
    this.timeoutMs = init.timeoutMs;
  }
}

/**
 * The request failed before a complete response arrived: DNS, a refused or
 * reset connection, TLS, a redirect that `redirect: 'error'` refused. `cause`
 * has the details, e.g. `cause.code === 'ECONNREFUSED'`.
 */
export class HttpNetworkError extends HttpClientError {
  constructor(init: { method: string; url: string; cause: unknown }) {
    const detail = init.cause as
      { code?: string; message?: string } | undefined;
    super(
      `${init.method} ${redactUrl(init.url)} failed: ${detail?.code ?? detail?.message ?? 'network error'}`,
      init,
    );
  }
}

function hidden(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}
