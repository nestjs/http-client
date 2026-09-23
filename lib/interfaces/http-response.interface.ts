import type { HttpRequest } from './http-request.interface.js';

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
