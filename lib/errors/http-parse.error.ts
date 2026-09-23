import { HttpClientError } from './http-client.error.js';
import type { HttpResponseErrorInit } from './http-response.error.js';
import { defineHidden } from '../utils/define-hidden.util.js';
import { redactUrl } from '../utils/url.util.js';

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
    defineHidden(this, 'headers', init.headers ?? new Headers());
    defineHidden(this, 'body', init.body ?? '');
  }
}
