import { HttpClientError } from './http-client.error.js';
import { redactUrl } from '../utils/url.util.js';

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
