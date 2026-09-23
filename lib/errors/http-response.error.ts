import { HttpClientError } from './http-client.error.js';
import { defineHidden } from '../utils/define-hidden.util.js';
import { redactUrl } from '../utils/url.util.js';

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
    defineHidden(this, 'headers', init.headers ?? new Headers());
    defineHidden(this, 'body', init.body);
  }
}
