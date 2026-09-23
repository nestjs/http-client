import type { Type } from '@nestjs/common';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  HttpClientError,
  HttpNetworkError,
  HttpParseError,
  HttpResponseError,
  HttpTimeoutError,
} from './http-client.errors.js';
import type {
  HttpClientInterceptor,
  HttpClientInterceptorFn,
  HttpClientInterceptorLike,
  HttpClientModuleOptions,
  HttpClientOptions,
  HeaderValue,
  HttpHandler,
  HttpHeadersInit,
  HttpRequest,
  HttpRequestOptions,
  HttpResponse,
  HttpResponseType,
  HttpSharedOptions,
} from './http-client.options.js';
import {
  backoffDelay,
  durationOption,
  isReplayableBody,
  mergeRetry,
  parseRetryAfter,
  resolveRetry,
  sleep,
  type ResolvedRetry,
  type RetryInput,
} from './retry.js';
import {
  appendQuery,
  applyPathParams,
  assertSendableUrl,
  parseBaseUrl,
  resolveUrl,
} from './url.js';

/** Options of the verb methods, which set `method` themselves. */
type HttpVerbOptions = Omit<HttpRequestOptions, 'method'>;

/** Call signature shared by `request()` and the verb methods; `data` follows `responseType`. */
export interface HttpMethodCall<O extends object = HttpRequestOptions> {
  (
    url: string,
    options: O & { responseType: 'stream' },
  ): Promise<HttpResponse<Readable>>;
  (
    url: string,
    options: O & { responseType: 'text' },
  ): Promise<HttpResponse<string>>;
  (
    url: string,
    options: O & { responseType: 'arrayBuffer' },
  ): Promise<HttpResponse<ArrayBuffer>>;
  (
    url: string,
    options: O & { responseType: 'response' },
  ): Promise<HttpResponse<Response>>;
  /** `T` describes the parsed JSON body; nothing validates it at runtime. */
  <T = unknown>(url: string, options?: O): Promise<HttpResponse<T>>;
}

type InterceptorResolver = (
  type: Type<HttpClientInterceptor>,
) => HttpClientInterceptor | Promise<HttpClientInterceptor>;

type Transport = Pick<HttpSharedOptions, 'redirect' | 'dispatcher'>;

type Timer = { signal: AbortSignal; clear(): void };

const EMPTY_BODY_STATUS = new Set([204, 205, 304]);

/** Stream bodies passed to fetch so far: a stream can be sent only once. */
const sentStreamBodies = new WeakSet<object>();

/**
 * Promise-based HTTP client on the platform `fetch`. Injected as `HttpClient`
 * (default client) or `@InjectHttpClient(name)`; also usable with `new`.
 */
export class HttpClient {
  readonly request: HttpMethodCall = ((
    url: string,
    options?: HttpRequestOptions,
  ) => this.send(url, options)) as HttpMethodCall;
  readonly get = this.verb('GET');
  readonly post = this.verb('POST');
  readonly put = this.verb('PUT');
  readonly patch = this.verb('PATCH');
  readonly delete = this.verb('DELETE');
  readonly head = this.verb('HEAD');
  readonly options = this.verb('OPTIONS');

  private readonly config: HttpClientOptions;
  private readonly baseUrl: URL | undefined;
  private readonly baseHeaders: Headers;
  private readonly timeout: number | undefined;
  private readonly retry: RetryInput;
  /** Outside Nest, class interceptors are created with `new`. */
  private resolveInterceptor: InterceptorResolver = (type) => new type();
  private interceptorFns?: Promise<HttpClientInterceptorFn[]>;

  /** Throws a `TypeError` naming the option for an invalid `baseUrl`, duration or interceptor. */
  constructor(options: HttpClientOptions = {}) {
    this.config = options;
    this.baseUrl = parseBaseUrl(options.baseUrl);
    this.baseHeaders = mergeHeaders(new Headers(), options.headers);
    this.timeout =
      options.timeout === undefined
        ? undefined
        : durationOption(options.timeout, 'timeout');
    this.retry = options.retry;
    resolveRetry(options.retry);
    (options.interceptors ?? []).forEach(checkInterceptor);
  }

  private verb(method: string): HttpMethodCall<HttpVerbOptions> {
    return ((url: string, options?: HttpVerbOptions) =>
      this.send(url, {
        ...options,
        method,
      })) as HttpMethodCall<HttpVerbOptions>;
  }

  private async send(
    path: string,
    options: HttpRequestOptions = {},
  ): Promise<HttpResponse<unknown>> {
    const config = this.config;
    const method = (options.method ?? 'GET').toUpperCase();
    const url = appendQuery(
      resolveUrl(this.baseUrl, applyPathParams(path, options.params)),
      options.query,
    );
    const headers = mergeHeaders(
      new Headers(this.baseHeaders),
      options.headers,
    );
    let body = options.body;
    if (options.json !== undefined) {
      if (body !== undefined)
        throw new TypeError('Pass either `json` or `body`, not both');
      body = JSON.stringify(options.json);
      if (!headers.has('content-type'))
        headers.set('content-type', 'application/json');
    }
    if (body != null && (method === 'GET' || method === 'HEAD')) {
      // fetch would reject this too, and the rejection would look like a network error
      throw new TypeError(
        `A ${method} request can't have a body. Send the values in \`query\`.`,
      );
    }
    const responseType = options.responseType ?? 'auto';
    const timeout =
      options.timeout === undefined
        ? this.timeout
        : durationOption(options.timeout, 'timeout');
    const throwOnHttpError =
      options.throwOnHttpError ?? config.throwOnHttpError ?? true;
    const transport: Transport = {
      redirect: options.redirect ?? config.redirect,
      dispatcher: options.dispatcher ?? config.dispatcher,
    };
    const retry = resolveRetry(mergeRetry(this.retry, options.retry));
    const retryable =
      !!retry && retry.methods.includes(method) && isReplayableBody(body);
    const signal = options.signal;
    const interceptors = await this.resolveInterceptors();

    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      const canRetry = retryable && attempt < retry!.attempts;
      const timer = createTimer(timeout);
      const request: HttpRequest = {
        method,
        url: new URL(url),
        headers: new Headers(headers),
        body,
        signal: anySignal(signal, timer?.signal),
        attempt,
        context: { ...options.context },
      };
      let sent = request;
      // Transient failures of this attempt's own fetch. Only these are
      // retried: an error from a call an interceptor makes (e.g. a token
      // request) propagates unchanged.
      const ownFailures = new WeakSet<object>();
      // Responses of this attempt, so those an interceptor drops free their connection
      const received: Response[] = [];
      const terminal: HttpHandler = async (req) => {
        sent = req;
        assertSendableUrl(req.url);
        claimStreamBody(req.body);
        try {
          const response = await this.fetch(req, transport);
          received.push(response);
          return response;
        } catch (error) {
          // Interceptors see timeouts as HttpTimeoutError, like network errors
          const failure = toClientError(error, req, timer, timeout, signal);
          if (isTransient(failure)) ownFailures.add(failure as object);
          throw failure;
        }
      };
      const handler = interceptors.reduceRight<HttpHandler>(
        (next, intercept) => (req) => intercept(req, next),
        terminal,
      );

      let response: Response;
      try {
        // The timeout and the caller's abort bound the interceptors too, even
        // one that awaits something without passing the signal on
        response = await settleBy(
          Promise.resolve(handler(request)),
          request.signal,
        );
      } catch (error) {
        timer?.clear();
        received.forEach(discard);
        const failure = toClientError(error, sent, timer, timeout, signal);
        const own =
          ownFailures.has(failure as object) ||
          // This attempt's timer fired while an interceptor was still working
          (failure !== error && failure instanceof HttpTimeoutError);
        if (
          canRetry &&
          own &&
          isTransient(failure) &&
          shouldRetry(retry!, failure, attempt)
        ) {
          await sleep(backoffDelay(retry!, attempt, failure), signal);
          continue;
        }
        throw failure;
      }
      // An interceptor may wrap a response: new Response(res.body, …) shares its stream
      received
        .filter((other) => other !== response && other.body !== response?.body)
        .forEach(discard);
      if (!isResponse(response)) {
        timer?.clear();
        throw new TypeError(
          `The request resolved to ${response === null ? 'null' : typeof response} instead of a ` +
            'Response. An interceptor must return what next() resolves to (`return next(request)`), ' +
            'and a custom `fetch` must resolve to a Response.',
        );
      }

      if (
        !response.ok &&
        canRetry &&
        retry!.statusCodes.includes(response.status)
      ) {
        let delay: number | undefined;
        try {
          delay = await retryDelay(retry!, response, sent, attempt, signal);
        } catch (error) {
          // retryIf or a backoff function threw, or the caller aborted
          timer?.clear();
          discard(response);
          throw error;
        }
        if (delay !== undefined) {
          timer?.clear();
          discard(response);
          await sleep(delay, signal);
          continue;
        }
      }

      // For streams the timeout covers the wait for headers, not the download;
      // an error body is still read under it.
      const leavesBodyUnread =
        responseType === 'stream' || responseType === 'response';
      if (leavesBodyUnread && (response.ok || !throwOnHttpError))
        timer?.clear();
      try {
        return await finish(
          response,
          sent,
          responseType,
          throwOnHttpError,
          signal,
        );
      } catch (error) {
        // Reading the body is part of the attempt: a reset or a timeout here is retried too
        const failure = toBodyError(error, sent, timer, timeout, signal);
        discard(response);
        if (
          canRetry &&
          isTransient(failure) &&
          shouldRetry(retry!, failure, attempt)
        ) {
          timer?.clear();
          await sleep(backoffDelay(retry!, attempt, failure), signal);
          continue;
        }
        throw failure;
      } finally {
        timer?.clear();
      }
    }
  }

  private async fetch(
    req: HttpRequest,
    transport: Transport,
  ): Promise<Response> {
    const fetchImpl = this.config.fetch ?? globalThis.fetch;
    // `dispatcher` and `duplex` are undici extensions to RequestInit; the dispatcher is typed
    // by its shape (HttpDispatcher), so undici's own types never reach the public API.
    const init: Omit<RequestInit, 'dispatcher'> &
      Transport & { duplex?: 'half' } = {
      method: req.method,
      headers: req.headers,
      body: req.body as RequestInit['body'],
      signal: req.signal,
    };
    if (transport.redirect) init.redirect = transport.redirect;
    if (transport.dispatcher) init.dispatcher = transport.dispatcher;
    if (!isReplayableBody(req.body)) init.duplex = 'half';
    try {
      return await fetchImpl(req.url, init as RequestInit);
    } catch (error) {
      if (req.signal.aborted) throw error;
      throw new HttpNetworkError({
        method: req.method,
        url: req.url.href,
        cause: (error as { cause?: unknown })?.cause ?? error,
      });
    }
  }

  private resolveInterceptors(): Promise<HttpClientInterceptorFn[]> {
    this.interceptorFns ??= Promise.all(
      (this.config.interceptors ?? []).map(
        async (entry: HttpClientInterceptorLike) => {
          if (isInterceptorClass(entry)) {
            const instance = await this.resolveInterceptor(entry);
            return instance.intercept.bind(instance);
          }
          if (typeof entry === 'function')
            return entry as HttpClientInterceptorFn;
          return entry.intercept.bind(entry);
        },
      ),
    ).catch((error) => {
      this.interceptorFns = undefined;
      throw error;
    });
    return this.interceptorFns;
  }
}

/** Used by `HttpClientModule`: class interceptors come from the DI container. */
export function createHttpClient(
  options: HttpClientOptions,
  resolveInterceptor: InterceptorResolver,
): HttpClient {
  const client = new HttpClient(options);
  client['resolveInterceptor'] = resolveInterceptor;
  return client;
}

/**
 * Resolves the client's interceptors now instead of on the first request.
 * `HttpClientModule` calls it from `onModuleInit`, so a class interceptor
 * whose dependencies can't be resolved fails the bootstrap.
 */
export async function initHttpClient(client: HttpClient): Promise<void> {
  await client['resolveInterceptors']();
}

/**
 * `forRoot()` defaults under a client's own options: the client's values win,
 * headers and retry settings merge, and global interceptors run first.
 */
export function mergeClientOptions(
  defaults: HttpClientModuleOptions | undefined,
  options: HttpClientOptions,
): HttpClientOptions {
  if (!defaults) return options;
  return {
    ...definedOnly(defaults),
    ...definedOnly(options),
    headers: mergeHeaders(new Headers(), defaults.headers, options.headers),
    retry: mergeRetry(defaults.retry, options.retry),
    interceptors: [
      ...(defaults.interceptors ?? []),
      ...(options.interceptors ?? []),
    ],
  };
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

/** A class to instantiate, as opposed to a function or an object with `intercept()`. */
export function isInterceptorClass(
  entry: unknown,
): entry is Type<HttpClientInterceptor> {
  return (
    typeof entry === 'function' &&
    typeof entry.prototype?.intercept === 'function'
  );
}

function checkInterceptor(entry: unknown, index: number): void {
  if (typeof entry === 'function') return;
  if (
    typeof (entry as { intercept?: unknown } | null)?.intercept === 'function'
  )
    return;
  throw new TypeError(
    `HttpClient \`interceptors[${index}]\` is ${entry === null ? 'null' : typeof entry}: expected a ` +
      'function, an object with intercept(), or a class that implements HttpClientInterceptor. ' +
      'An undefined entry usually means a circular import.',
  );
}

/**
 * Layers header inputs; `null` removes, `undefined` is ignored, arrays repeat.
 * An invalid value (a line break, say) throws without echoing it, since
 * header values are often credentials.
 */
export function mergeHeaders(
  target: Headers,
  ...layers: (HttpHeadersInit | undefined)[]
): Headers {
  for (const layer of layers) {
    if (!layer) continue;
    const entries: [string, HeaderValue][] = [];
    if (isHeadersLike(layer))
      layer.forEach((value, key) => entries.push([key, value]));
    else entries.push(...Object.entries(layer));
    for (const [key, value] of entries) {
      if (value === undefined) continue;
      target.delete(key); // throws for an invalid name, which is safe to show
      if (value === null) continue;
      for (const item of Array.isArray(value) ? value : [String(value)]) {
        try {
          target.append(key, item);
        } catch {
          throw new TypeError(
            `Invalid value for the "${key}" header: it contains a line break or NUL`,
          );
        }
      }
    }
  }
  return target;
}

/** A `Headers` instance, from this realm or another one (undici's own class, a polyfill). */
function isHeadersLike(value: object): value is Headers {
  if (value instanceof Headers) return true;
  const candidate = value as Partial<Headers>;
  return (
    typeof candidate.forEach === 'function' &&
    typeof candidate.get === 'function' &&
    typeof candidate.has === 'function'
  );
}

/** Throws when a stream body is about to be sent a second time, which would send it empty. */
function claimStreamBody(body: unknown): void {
  if (isReplayableBody(body)) return;
  if (sentStreamBodies.has(body as object)) {
    throw new TypeError(
      'The request body is a stream that was already sent, and a stream can be sent only once. ' +
        'To send a request again (e.g. from an interceptor, after a 401), give it a string, ' +
        'Buffer, Blob, FormData or URLSearchParams body.',
    );
  }
  sentStreamBodies.add(body as object);
}

/**
 * Asks `retryIf`, which may only narrow the defaults. What it throws
 * propagates, like a bug anywhere else; a Promise is refused, since it would
 * always count as `true`.
 */
function shouldRetry(
  retry: ResolvedRetry,
  error: unknown,
  attempt: number,
): boolean {
  if (!retry.retryIf) return true;
  const verdict: unknown = retry.retryIf(error, attempt);
  if (
    typeof (verdict as PromiseLike<unknown> | undefined)?.then === 'function'
  ) {
    (verdict as Promise<unknown>).then(undefined, () => undefined);
    throw new TypeError(
      'HttpClient `retry.retryIf` must return a boolean, not a Promise',
    );
  }
  return !!verdict;
}

/**
 * The wait before retrying a response with a retryable status, or `undefined`
 * to stop. `Retry-After` replaces the backoff, and one longer than
 * `maxDelay` is not waited out.
 */
async function retryDelay(
  retry: ResolvedRetry,
  response: Response,
  request: HttpRequest,
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  // User code sees the failure as an HttpResponseError; read from a clone, so
  // the response can still be returned or thrown when there is no retry.
  const error =
    retry.retryIf || typeof retry.backoff === 'function'
      ? await toResponseError(response.clone(), request, signal)
      : undefined;
  if (retry.retryIf && !shouldRetry(retry, error, attempt)) return undefined;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter !== undefined)
    return retryAfter <= retry.maxRetryAfter ? retryAfter : undefined;
  return backoffDelay(retry, attempt, error);
}

/**
 * Connection-level failures and timeouts. A network error without a `code`
 * (a redirect that `redirect: 'error'` refused, too many redirects) fails the
 * same way on every attempt.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof HttpTimeoutError) return true;
  return (
    error instanceof HttpNetworkError &&
    typeof (error.cause as { code?: unknown } | undefined)?.code === 'string'
  );
}

function createTimer(ms: number | undefined): Timer | undefined {
  if (!ms) return undefined;
  const controller = new AbortController();
  const handle = setTimeout(
    () =>
      controller.abort(
        new DOMException(`Timed out after ${ms}ms`, 'TimeoutError'),
      ),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(handle) };
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return new AbortController().signal;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

/**
 * A failure of one attempt as the caller sees it: the client's own errors as
 * they are, the caller's abort as its reason, the attempt's timer as an
 * `HttpTimeoutError`, and anything else as `otherwise` makes it.
 */
function toClientError(
  error: unknown,
  request: HttpRequest,
  timer: Timer | undefined,
  timeoutMs: number | undefined,
  userSignal: AbortSignal | undefined,
  otherwise: (error: unknown) => unknown = (error) => error,
): unknown {
  if (error instanceof HttpClientError) return error;
  if (userSignal?.aborted && error === userSignal.reason) return error;
  if (timer?.signal.aborted) {
    return new HttpTimeoutError({
      method: request.method,
      url: request.url.href,
      timeoutMs: timeoutMs!,
      cause: error,
    });
  }
  if (userSignal?.aborted) return userSignal.reason;
  return otherwise(error);
}

/** Reading the body failed: past the checks above, that is the connection (e.g. a reset). */
function toBodyError(
  error: unknown,
  request: HttpRequest,
  timer: Timer | undefined,
  timeoutMs: number | undefined,
  userSignal: AbortSignal | undefined,
): unknown {
  return toClientError(
    error,
    request,
    timer,
    timeoutMs,
    userSignal,
    (cause) =>
      new HttpNetworkError({
        method: request.method,
        url: request.url.href,
        cause: (cause as { cause?: unknown })?.cause ?? cause,
      }),
  );
}

/** A `Response`, from this realm or another fetch implementation (the undici package's). */
function isResponse(value: unknown): value is Response {
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
function settleBy(
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
function discard(response: Response): void {
  if (response.bodyUsed || !response.body) return;
  response.body.cancel().catch(() => undefined);
}

function isJson(contentType: string | null): boolean {
  return !!contentType && /[/+]json\b/i.test(contentType);
}

async function finish(
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
async function toResponseError(
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
