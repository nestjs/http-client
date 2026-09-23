import type { Type } from '@nestjs/common';
import { Readable } from 'node:stream';
import { HttpNetworkError } from './errors/http-network.error.js';
import { HttpTimeoutError } from './errors/http-timeout.error.js';
import type {
  HttpClientInterceptor,
  HttpClientInterceptorFn,
  HttpClientInterceptorLike,
  HttpHandler,
} from './interfaces/http-client-interceptor.interface.js';
import type {
  HttpClientOptions,
  HttpSharedOptions,
} from './interfaces/http-client-options.interface.js';
import type {
  HttpRequest,
  HttpRequestOptions,
} from './interfaces/http-request.interface.js';
import type { HttpResponse } from './interfaces/http-response.interface.js';
import { toBodyError, toClientError } from './utils/client-error.util.js';
import {
  checkInterceptor,
  isInterceptorClass,
} from './utils/client-options.util.js';
import { durationOption } from './utils/duration.util.js';
import { mergeHeaders } from './utils/headers.util.js';
import {
  claimStreamBody,
  isReplayableBody,
} from './utils/request-body.util.js';
import {
  discard,
  finish,
  isResponse,
  settleBy,
} from './utils/response.util.js';
import {
  type RetryInput,
  backoffDelay,
  isTransient,
  mergeRetry,
  resolveRetry,
  retryDelay,
  shouldRetry,
} from './utils/retry.util.js';
import { anySignal, createTimer, sleep } from './utils/timers.util.js';
import {
  appendQuery,
  applyPathParams,
  assertSendableUrl,
  parseBaseUrl,
  resolveUrl,
} from './utils/url.util.js';

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
