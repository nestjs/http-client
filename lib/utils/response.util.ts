import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { HttpParseError } from '../errors/http-parse.error.js';
import { HttpResponseError } from '../errors/http-response.error.js';
import type {
  HttpRequest,
  HttpResponseType,
} from '../interfaces/http-request.interface.js';
import type { HttpResponse } from '../interfaces/http-response.interface.js';

const EMPTY_BODY_STATUS = new Set([204, 205, 304]);

/** A `Response`, from this realm or another fetch implementation (the undici package's). */
export function isResponse(value: unknown): value is Response {
  const candidate = value as Partial<Response> | null | undefined;
  return (
    typeof candidate?.status === 'number' &&
    typeof candidate.headers?.get === 'function'
  );
}

/**
 * `promise`, or the signal's reason once it aborts. A chain that passes the
 * signal on settles by itself right away, with the error its interceptors saw,
 * so it gets a turn of the event loop first. A response that arrives after
 * the attempt was given up is released, and a late rejection is handled.
 */
export function settleBy(
  promise: Promise<Response>,
  signal: AbortSignal,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      finish();
    };
    const onAbort = () =>
      setImmediate(() =>
        settle(() => {
          reject(signal.reason);
          promise.then(
            (late) => isResponse(late) && discard(late),
            () => undefined,
          );
        }),
      );
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (response) => settle(() => resolve(response)),
      (error) => settle(() => reject(error)),
    );
  });
}

/**
 * Frees the connection of a response whose body won't be read. Not awaited:
 * cancelling one branch of a clone settles only once the other is read.
 */
export function discard(response: Response): void {
  if (response.bodyUsed || !response.body) return;
  response.body.cancel().catch(() => undefined);
}

function isJson(contentType: string | null): boolean {
  return !!contentType && /[/+]json\b/i.test(contentType);
}

export async function finish(
  response: Response,
  request: HttpRequest,
  responseType: HttpResponseType,
  throwOnHttpError: boolean,
  signal: AbortSignal | undefined,
): Promise<HttpResponse<unknown>> {
  if (!response.ok && throwOnHttpError) {
    throw await toResponseError(response, request, signal);
  }
  return {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
    url: response.url || request.url.href,
    request,
    data: await readBody(response, responseType, request),
  };
}

/**
 * The status is what matters: a body cut short by a reset or a timeout is
 * left `undefined`. A caller's abort still rejects with its reason.
 */
export async function toResponseError(
  response: Response,
  request: HttpRequest,
  signal: AbortSignal | undefined,
): Promise<HttpResponseError> {
  let body: unknown;
  try {
    body = await readErrorBody(response);
  } catch {
    if (signal?.aborted) throw signal.reason;
    body = undefined;
  }
  return new HttpResponseError({
    method: request.method,
    url: request.url.href,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body,
  });
}

async function readBody(
  response: Response,
  type: HttpResponseType,
  request: HttpRequest,
): Promise<unknown> {
  switch (type) {
    case 'response':
      return response;
    case 'stream':
      return response.body
        ? Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
        : Readable.from([]);
    case 'arrayBuffer':
      return response.arrayBuffer();
    case 'text':
      return response.text();
    case 'json':
      return parseJson(await response.text(), response, request);
    case 'auto': {
      if (request.method === 'HEAD' || EMPTY_BODY_STATUS.has(response.status)) {
        discard(response);
        return undefined;
      }
      const text = await response.text();
      if (!text) return undefined;
      return isJson(response.headers.get('content-type'))
        ? parseJson(text, response, request)
        : text;
    }
  }
}

function parseJson(
  text: string,
  response: Response,
  request: HttpRequest,
): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A non-2xx answer the caller asked for as a value (throwOnHttpError: false)
    // is read like an error body: a gateway's HTML page stays text
    if (!response.ok) return text;
    // Not the SyntaxError itself: its message quotes the body, and messages end up in logs
    throw new HttpParseError({
      method: request.method,
      url: request.url.href,
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: text,
    });
  }
}

async function readErrorBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  if (!isJson(response.headers.get('content-type'))) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
