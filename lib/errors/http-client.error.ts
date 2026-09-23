import { defineHidden } from '../utils/define-hidden.util.js';

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
    defineHidden(this, 'url', init.url);
  }
}
