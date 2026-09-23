import { createHash } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inspect } from 'node:util';
import {
  BadGatewayException,
  GatewayTimeoutException,
  HttpException,
  Logger,
} from '@nestjs/common';
import {
  HttpClient,
  HttpClientError,
  HttpNetworkError,
  HttpParseError,
  HttpResponseError,
  HttpTimeoutError,
  toHttpException,
  type HttpClientInterceptorFn,
  type HttpHandler,
  type HttpRequest,
} from '../lib/index.js';
import { echo, sendJson, startServer, type TestServer } from './server.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let server: TestServer;
/** Remaining failures per route, set by each test. */
let failures: Record<string, number> = {};

beforeAll(async () => {
  server = await startServer(async (req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    const fail = (name: string) =>
      (failures[name] ?? 0) > 0 && failures[name]-- > 0;
    switch (path) {
      case '/flaky':
        if (fail('flaky')) return sendJson(res, 503, { error: 'unavailable' });
        return sendJson(res, 200, { ok: true, method: req.method });
      case '/retry-after':
        if (fail('retry-after')) {
          res.writeHead(429, {
            'retry-after': req.headers['x-retry-after'] as string,
          });
          return res.end();
        }
        return sendJson(res, 200, { ok: true });
      case '/missing':
        return sendJson(res, 404, {
          message: 'User 7 not found',
          code: 'E_NOT_FOUND',
        });
      case '/text-error':
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.end('boom');
      case '/slow':
        await sleep(
          Number(new URL(req.url!, 'http://x').searchParams.get('ms') ?? 200),
        );
        return sendJson(res, 200, { ok: true });
      case '/no-content':
        res.writeHead(204);
        return res.end();
      case '/plain':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end('hello');
      case '/large': {
        // 16 MiB in 64 KiB chunks, honoring backpressure.
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        const chunk = Buffer.alloc(64 * 1024, 7);
        for (let i = 0; i < 256; i++) {
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
        }
        return res.end();
      }
      case '/slow-stream':
        res.writeHead(200, { 'content-type': 'text/plain' });
        for (let i = 0; i < 4; i++) {
          res.write(`chunk${i};`);
          await sleep(100);
        }
        return res.end();
      case '/reset-body':
        if (fail('reset-body')) {
          // Headers and half a body, then the connection drops
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': '100',
          });
          res.write('{"partial":');
          await sleep(10);
          return req.socket.destroy();
        }
        return sendJson(res, 200, { ok: true });
      case '/slow-body':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"ok":');
        await sleep(fail('slow-body') ? 300 : 0);
        return res.end('true}');
      case '/bad-json':
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('<html>jane@example.com</html>');
      case '/stalled-error':
        // An error body that never ends
        res.writeHead(500, { 'content-type': 'text/plain' });
        return res.write('partial');
      case '/redirect':
        res.writeHead(302, { location: '/plain' });
        return res.end();
      case '/auth':
        if (fail('auth')) {
          res.writeHead(401);
          return res.end();
        }
        return sendJson(res, 200, { ok: true });
      default:
        return echo(req, res);
    }
  });
});
afterAll(() => server.close());
beforeEach(() => {
  failures = {};
  server.requests.length = 0;
});

describe('HttpClient', () => {
  it('joins the base URL and serializes query objects', async () => {
    const client = new HttpClient({ baseUrl: `${server.url}/api/v1/` });
    const res = await client.get<{ url: string }>('/users/:id/posts', {
      params: { id: 'a b/c' },
      query: {
        tag: ['x', 'y'],
        page: 2,
        draft: false,
        skip: undefined,
        none: null,
        since: new Date(0),
      },
    });
    expect(res.status).toBe(200);
    expect(res.data.url).toBe(
      '/api/v1/users/a%20b%2Fc/posts?tag=x&tag=y&page=2&draft=false&since=1970-01-01T00%3A00%3A00.000Z',
    );
    // Absolute URLs bypass the base URL; an existing query is kept.
    const abs = await client.get<{ url: string }>(`${server.url}/other?a=1`, {
      query: { b: 2 },
    });
    expect(abs.data.url).toBe('/other?a=1&b=2');
  });

  it('serializes `json` bodies and parses JSON responses', async () => {
    const client = new HttpClient({ baseUrl: server.url });
    const res = await client.post<{
      method: string;
      headers: Record<string, string>;
      body: unknown;
    }>('/users', { json: { name: 'Kamil', tags: ['a'] } });
    expect(res.data.method).toBe('POST');
    expect(res.data.headers['content-type']).toBe('application/json');
    expect(res.data.body).toEqual({ name: 'Kamil', tags: ['a'] });
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.request.method).toBe('POST');
  });

  it('reads text, empty and arrayBuffer bodies by response type', async () => {
    const client = new HttpClient({ baseUrl: server.url });
    expect((await client.get('/plain')).data).toBe('hello');
    expect((await client.get('/no-content')).data).toBeUndefined();
    expect((await client.head('/plain')).data).toBeUndefined();
    const buf = await client.get('/plain', { responseType: 'arrayBuffer' });
    expect(Buffer.from(buf.data).toString()).toBe('hello');
    const raw = await client.get('/plain', { responseType: 'response' });
    expect(await raw.data.text()).toBe('hello');
  });

  it('types `data` by responseType, and keeps `method` off the verb methods', async () => {
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      fetch: async () => Response.json({ id: 1 }),
    });
    expectTypeOf(
      (await client.get('/x', { responseType: 'stream' })).data,
    ).toEqualTypeOf<Readable>();
    expectTypeOf(
      (await client.get('/x', { responseType: 'text' })).data,
    ).toEqualTypeOf<string>();
    expectTypeOf(
      (await client.get('/x', { responseType: 'arrayBuffer' })).data,
    ).toEqualTypeOf<ArrayBuffer>();
    expectTypeOf(
      (await client.get('/x', { responseType: 'response' })).data,
    ).toEqualTypeOf<Response>();
    expectTypeOf((await client.get<{ id: number }>('/x')).data).toEqualTypeOf<{
      id: number;
    }>();
    expectTypeOf((await client.get('/x')).data).toEqualTypeOf<unknown>();
    // @ts-expect-error: the verb methods set the method themselves
    await client.get('/x', { method: 'POST' });
  });

  it('merges default headers with per-request overrides and removals', async () => {
    const client = new HttpClient({
      baseUrl: server.url,
      headers: {
        'x-api-key': 'default',
        'x-client': 'nest',
        accept: 'application/json',
      },
    });
    const res = await client.get<{ headers: Record<string, string> }>('/', {
      headers: { 'x-api-key': 'override', 'x-client': null, 'x-extra': 1 },
    });
    expect(res.data.headers['x-api-key']).toBe('override');
    expect(res.data.headers['x-client']).toBeUndefined();
    expect(res.data.headers['x-extra']).toBe('1');
    expect(res.data.headers.accept).toBe('application/json');
  });

  it('runs interceptors in order, outermost first, around each call', async () => {
    const log: string[] = [];
    const tag =
      (name: string): HttpClientInterceptorFn =>
      async (req, next) => {
        log.push(`${name}:req`);
        req.headers.append('x-chain', name);
        const res = await next(req);
        log.push(`${name}:res:${res.status}`);
        return res;
      };
    const client = new HttpClient({
      baseUrl: server.url,
      interceptors: [tag('a'), tag('b')],
    });
    const res = await client.get<{ headers: Record<string, string> }>('/');
    expect(log).toEqual(['a:req', 'b:req', 'b:res:200', 'a:res:200']);
    expect(res.data.headers['x-chain']).toBe('a, b');
  });

  it('throws HttpResponseError with status, request info and the parsed JSON body', async () => {
    const client = new HttpClient({ baseUrl: server.url });
    const error = await client.get('/missing').catch((e) => e);
    expect(error).toBeInstanceOf(HttpResponseError);
    expect(error).toMatchObject({
      status: 404,
      statusText: 'Not Found',
      method: 'GET',
      url: `${server.url}/missing`,
      body: { message: 'User 7 not found', code: 'E_NOT_FOUND' },
    });
    expect(error.message).toBe(
      `GET ${server.url}/missing failed with 404 Not Found`,
    );
    expect(error.headers.get('content-type')).toBe('application/json');

    // 500 is retryable by default; disabled here to assert on the first failure
    const textError = await client
      .get('/text-error', { retry: false })
      .catch((e) => e);
    expect(textError.body).toBe('boom');
    expect(server.requests).toHaveLength(2);
  });

  it('returns non-2xx responses with throwOnHttpError: false', async () => {
    const client = new HttpClient({
      baseUrl: server.url,
      throwOnHttpError: false,
    });
    const res = await client.get<{ code: string }>('/missing');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
    expect(res.data.code).toBe('E_NOT_FOUND');
    // ...and per request, the other way round
    await expect(
      client.get('/missing', { throwOnHttpError: true }),
    ).rejects.toBeInstanceOf(HttpResponseError);
  });

  it('throws HttpTimeoutError when the timeout elapses', async () => {
    const client = new HttpClient({
      baseUrl: server.url,
      timeout: '50ms',
      retry: false,
    });
    const error = await client
      .get('/slow', { query: { ms: 500 } })
      .catch((e) => e);
    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect(error.timeoutMs).toBe(50);
    expect(error.message).toBe(
      `GET ${server.url}/slow?ms=*** timed out after 50ms`,
    );
    expect(error.cause).toBeInstanceOf(DOMException);
    // Per-request override; 0 turns the timeout off
    await expect(
      client.get('/slow', { query: { ms: 20 }, timeout: '1s' }),
    ).resolves.toMatchObject({
      status: 200,
    });
    await expect(
      client.get('/slow', { query: { ms: 80 }, timeout: 0 }),
    ).resolves.toMatchObject({
      status: 200,
    });
  });

  it('rejects an invalid timeout when the client is created, naming the option', async () => {
    expect(() => new HttpClient({ timeout: '5 seconds' as '5s' })).toThrow(
      'HttpClient `timeout`: Invalid duration "5 seconds"',
    );
    // setTimeout can't wait longer than about 24.8 days, and would fire at once
    expect(() => new HttpClient({ timeout: '30d' })).toThrow(
      'HttpClient `timeout`: "30d" is longer than a timer can wait (about 24.8 days)',
    );
    const client = new HttpClient({ baseUrl: server.url });
    await expect(client.get('/', { timeout: -1 })).rejects.toThrow(
      /HttpClient `timeout`/,
    );
  });

  it('rejects with the user signal reason when aborted', async () => {
    const client = new HttpClient({ baseUrl: server.url, timeout: 5000 });
    const controller = new AbortController();
    const pending = client.get('/slow', {
      query: { ms: 500 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const error = await pending.catch((e) => e);
    expect(error).not.toBeInstanceOf(HttpTimeoutError);
    expect(error.name).toBe('AbortError');
    // Retries are on by default, but a user abort is never retried
    await sleep(50);
    expect(server.requests).toHaveLength(1);
  });

  it('wraps connection failures in HttpNetworkError with the cause', async () => {
    const closed = await startServer(() => undefined);
    await closed.close();
    const client = new HttpClient({ baseUrl: closed.url, retry: false });
    const error = await client.get('/').catch((e) => e);
    expect(error).toBeInstanceOf(HttpNetworkError);
    expect(error.cause.code).toBe('ECONNREFUSED');
  });

  it('keeps query values and credentials out of error messages, but not out of `url`', async () => {
    const client = new HttpClient({ baseUrl: server.url, retry: false });
    const error = await client
      .get('/missing', {
        query: { email: 'jane@example.com', token: 's3cret' },
      })
      .catch((e) => e);
    expect(error.message).toBe(
      `GET ${server.url}/missing?email=***&token=*** failed with 404 Not Found`,
    );
    expect(error.url).toBe(
      `${server.url}/missing?email=jane%40example.com&token=s3cret`,
    );

    const url = 'https://user:pass@api.example.com/v1/x?key=abc&flag#frag';
    for (const e of [
      new HttpResponseError({ method: 'GET', url, status: 500 }),
      new HttpTimeoutError({ method: 'GET', url, timeoutMs: 10 }),
      new HttpNetworkError({
        method: 'GET',
        url,
        cause: { code: 'ECONNRESET' },
      }),
    ]) {
      expect(e.message).toContain(
        'GET https://api.example.com/v1/x?key=***&*** ',
      );
      expect(e.message).not.toMatch(/abc|user|pass|frag/);
      expect(e.url).toBe(url);
    }
  });

  it('bounds the attempt, interceptors included, by the timeout and the caller signal', async () => {
    const stuck: HttpClientInterceptorFn = () =>
      new Promise<Response>(() => undefined);
    const client = new HttpClient({
      baseUrl: server.url,
      timeout: 50,
      retry: false,
      interceptors: [stuck],
    });
    const started = Date.now();
    await expect(client.get('/')).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(Date.now() - started).toBeLessThan(1_000);

    const noTimeout = new HttpClient({
      baseUrl: server.url,
      interceptors: [stuck],
    });
    const reason = new Error('the caller left');
    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), 20);
    await expect(
      noTimeout.get('/', { signal: controller.signal }),
    ).rejects.toBe(reason);
  }, 2_000);

  it('hands interceptors a timeout as HttpTimeoutError, like network errors', async () => {
    const seen: unknown[] = [];
    const client = new HttpClient({
      baseUrl: server.url,
      timeout: 30,
      retry: false,
      interceptors: [
        (req, next) =>
          next(req).catch((e) => (seen.push(e), Promise.reject(e))),
      ],
    });
    const error = await client
      .get('/slow', { query: { ms: 300 } })
      .catch((e) => e);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeInstanceOf(HttpTimeoutError);
    expect(error).toBe(seen[0]);
    expect(error.cause).toBeInstanceOf(DOMException);
  });

  describe('retries', () => {
    // Only the base delay is shrunk; everything else is the default policy.
    const retry = { backoff: { delay: 1 } };

    it('retries idempotent requests by default (3 attempts total)', async () => {
      failures.flaky = 10;
      const client = new HttpClient({ baseUrl: server.url, retry });
      await expect(client.get('/flaky')).rejects.toMatchObject({ status: 503 });
      expect(server.requests).toHaveLength(3);
    });

    it('never retries POST or PATCH by default', async () => {
      const client = new HttpClient({ baseUrl: server.url }); // untouched defaults
      for (const method of ['post', 'patch'] as const) {
        failures.flaky = 1;
        server.requests.length = 0;
        await expect(
          client[method]('/flaky', { json: {} }),
        ).rejects.toMatchObject({ status: 503 });
        expect(server.requests).toHaveLength(1);
      }
    });

    it('can be disabled per client and re-enabled or tuned per request', async () => {
      failures.flaky = 1;
      const client = new HttpClient({ baseUrl: server.url, retry: false });
      await expect(client.get('/flaky')).rejects.toMatchObject({ status: 503 });
      expect(server.requests).toHaveLength(1);

      failures.flaky = 3;
      server.requests.length = 0;
      const res = await client.get('/flaky', {
        retry: { attempts: 4, backoff: { delay: 1 } },
      });
      expect(res.status).toBe(200);
      expect(server.requests).toHaveLength(4);
    });

    it('stops retrying when the user aborts during the backoff', async () => {
      failures.flaky = 10;
      const client = new HttpClient({
        baseUrl: server.url,
        retry: { backoff: { delay: 10_000, maxDelay: 10_000 } },
      });
      const controller = new AbortController();
      const pending = client.get('/flaky', { signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      const error = await pending.catch((e) => e);
      expect(error.name).toBe('AbortError');
      expect(server.requests).toHaveLength(1);
    });

    it('retries a 503 and then succeeds', async () => {
      failures.flaky = 2;
      const client = new HttpClient({ baseUrl: server.url, retry });
      const res = await client.get('/flaky');
      expect(res.status).toBe(200);
      expect(server.requests).toHaveLength(3);
    });

    it('runs interceptors once per attempt, with the attempt number', async () => {
      failures.flaky = 1;
      const attempts: number[] = [];
      const client = new HttpClient({
        baseUrl: server.url,
        retry,
        interceptors: [(req, next) => (attempts.push(req.attempt), next(req))],
      });
      await client.get('/flaky');
      expect(attempts).toEqual([1, 2]);
    });

    it('gives up after `attempts` and throws the last error', async () => {
      failures.flaky = 10;
      const client = new HttpClient({ baseUrl: server.url, retry });
      const error = await client.get('/flaky').catch((e) => e);
      expect(error).toBeInstanceOf(HttpResponseError);
      expect(error.status).toBe(503);
      expect(server.requests).toHaveLength(3);
    });

    it('does not retry POST by default, but can opt in per request', async () => {
      failures.flaky = 1;
      const client = new HttpClient({ baseUrl: server.url, retry });
      await expect(client.post('/flaky', { json: {} })).rejects.toMatchObject({
        status: 503,
      });
      expect(server.requests).toHaveLength(1);

      failures.flaky = 1;
      const res = await client.post('/flaky', {
        json: {},
        headers: { 'idempotency-key': 'k1' },
        retry: { methods: ['POST'] },
      });
      expect(res.status).toBe(200);
      expect(server.requests).toHaveLength(3);
    });

    it('never retries a stream request body', async () => {
      failures.flaky = 1;
      const client = new HttpClient({ baseUrl: server.url, retry });
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('payload'));
          c.close();
        },
      });
      await expect(client.put('/flaky', { body })).rejects.toMatchObject({
        status: 503,
      });
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0].body).toBe('payload');
    });

    it('honors Retry-After in seconds', async () => {
      failures['retry-after'] = 1;
      const client = new HttpClient({ baseUrl: server.url, retry });
      const started = Date.now();
      const res = await client.get('/retry-after', {
        headers: { 'x-retry-after': '1' },
      });
      expect(res.status).toBe(200);
      expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    });

    it('does not wait out a Retry-After beyond maxDelay', async () => {
      failures['retry-after'] = 1;
      const client = new HttpClient({
        baseUrl: server.url,
        retry: { backoff: { delay: 1, maxDelay: 500 } },
      });
      const started = Date.now();
      const error = await client
        .get('/retry-after', { headers: { 'x-retry-after': '120' } })
        .catch((e) => e);
      expect(error.status).toBe(429);
      expect(Date.now() - started).toBeLessThan(500);
    });

    it('does not retry a failure of a request made inside an interceptor', async () => {
      const closed = await startServer(() => undefined);
      await closed.close();
      const tokens = new HttpClient({ baseUrl: closed.url, retry: false });
      let calls = 0;
      const client = new HttpClient({
        baseUrl: server.url,
        retry,
        interceptors: [
          async (req, next) => {
            calls++;
            await tokens.post('/oauth/token'); // fails with ECONNREFUSED
            return next(req);
          },
        ],
      });
      const error = await client.get('/').catch((e) => e);
      expect(error).toBeInstanceOf(HttpNetworkError);
      expect(error.url).toBe(`${closed.url}/oauth/token`);
      expect(calls).toBe(1);
      expect(server.requests).toHaveLength(0);
    });

    it('retries timeouts and connection errors for idempotent methods', async () => {
      const client = new HttpClient({
        baseUrl: server.url,
        timeout: 30,
        retry,
      });
      await expect(
        client.get('/slow', { query: { ms: 200 } }),
      ).rejects.toBeInstanceOf(HttpTimeoutError);
      expect(server.requests).toHaveLength(3);
    });

    it('asks retryIf about each retryable failure, with the response body read', async () => {
      failures.flaky = 10;
      const seen: [unknown, number][] = [];
      const client = new HttpClient({
        baseUrl: server.url,
        retry: {
          ...retry,
          retryIf: (error, attempt) => {
            seen.push([error, attempt]);
            return attempt < 2;
          },
        },
      });
      const error = await client.get('/flaky').catch((e) => e);
      expect(error).toBeInstanceOf(HttpResponseError);
      expect(server.requests).toHaveLength(2);
      expect(seen.map(([, attempt]) => attempt)).toEqual([1, 2]);
      expect(seen[0][0]).toBeInstanceOf(HttpResponseError);
      expect(seen[0][0]).toMatchObject({
        status: 503,
        body: { error: 'unavailable' },
      });
      // The thrown error still has its body, although retryIf read it first
      expect(error.body).toEqual({ error: 'unavailable' });
    });

    it('returns the response when retryIf declines and throwOnHttpError is off', async () => {
      failures.flaky = 10;
      const client = new HttpClient({
        baseUrl: server.url,
        throwOnHttpError: false,
        retry: {
          ...retry,
          retryIf: (error) => (error as HttpResponseError).status !== 503,
        },
      });
      const res = await client.get<{ error: string }>('/flaky');
      expect(res.status).toBe(503);
      expect(res.data).toEqual({ error: 'unavailable' });
      expect(server.requests).toHaveLength(1);
    });

    it('lets retryIf turn off retries after connection errors', async () => {
      const closed = await startServer(() => undefined);
      await closed.close();
      const retryIf = vi.fn(
        (error: unknown) => !(error instanceof HttpNetworkError),
      );
      const client = new HttpClient({
        baseUrl: closed.url,
        retry: { ...retry, retryIf },
      });
      await expect(client.get('/')).rejects.toBeInstanceOf(HttpNetworkError);
      expect(retryIf).toHaveBeenCalledTimes(1);
    });

    it('clears the attempt timer and releases the response when retryIf or backoff throws', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const responses: Response[] = [];
        const fetch = async () => {
          responses.push(new Response('{}', { status: 503 }));
          return responses.at(-1)!;
        };
        const throwing = new HttpClient({
          baseUrl: 'https://api.example.com',
          timeout: '1m',
          fetch,
          retry: {
            retryIf: () => {
              throw new Error('bug in retryIf');
            },
          },
        });
        await expect(throwing.get('/x')).rejects.toThrow('bug in retryIf');
        expect(vi.getTimerCount()).toBe(0);
        expect(responses[0].bodyUsed).toBe(true);

        const badBackoff = new HttpClient({
          baseUrl: 'https://api.example.com',
          timeout: '1m',
          fetch,
          retry: { backoff: () => '1 minute' as '1m' },
        });
        await expect(badBackoff.get('/x')).rejects.toThrow(
          'HttpClient `retry.backoff()`: Invalid duration "1 minute"',
        );
        expect(vi.getTimerCount()).toBe(0);
        expect(responses[1].bodyUsed).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('refuses a retryIf that returns a Promise, which would always count as true', async () => {
      failures.flaky = 1;
      const retryIf = (async () => false) as unknown as () => boolean;
      const client = new HttpClient({
        baseUrl: server.url,
        retry: { ...retry, retryIf },
      });
      await expect(client.get('/flaky')).rejects.toThrow(
        'HttpClient `retry.retryIf` must return a boolean, not a Promise',
      );
      expect(server.requests).toHaveLength(1);
    });

    it('does not retry a redirect that `redirect: error` refuses: it fails the same way every time', async () => {
      const client = new HttpClient({
        baseUrl: server.url,
        redirect: 'error',
        retry,
      });
      const error = await client.get('/redirect').catch((e) => e);
      expect(error).toBeInstanceOf(HttpNetworkError);
      expect(error.message).toBe(
        `GET ${server.url}/redirect failed: unexpected redirect`,
      );
      expect(server.requests).toHaveLength(1);
    });

    it('rejects a URL with credentials before sending, without echoing them', async () => {
      const client = new HttpClient({ retry });
      const url = server.url.replace('http://', 'http://user:s3cret@');
      const error = await client.get(`${url}/`).catch((e) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe(
        `"${server.url}/" includes credentials, which fetch rejects. Send them in the \`authorization\` header.`,
      );
      expect(server.requests).toHaveLength(0);
    });

    it('waits what a backoff function returns, given the failure', async () => {
      failures.flaky = 2;
      const backoff = vi.fn((attempt: number, error: unknown) =>
        (error as HttpResponseError).status === 503
          ? (`${attempt}ms` as const)
          : 0,
      );
      const client = new HttpClient({
        baseUrl: server.url,
        retry: { backoff },
      });
      await expect(client.get('/flaky')).resolves.toMatchObject({
        status: 200,
      });
      expect(backoff.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2]);
      expect(backoff.mock.calls[0][1]).toBeInstanceOf(HttpResponseError);
    });
  });

  describe('failures while reading the body', () => {
    const retry = { backoff: { delay: 1 } };

    it('turns a connection reset mid-body into HttpNetworkError, and retries it', async () => {
      failures['reset-body'] = 1;
      const client = new HttpClient({ baseUrl: server.url, retry });
      await expect(client.get('/reset-body')).resolves.toMatchObject({
        data: { ok: true },
      });
      expect(server.requests).toHaveLength(2);

      failures['reset-body'] = 1;
      const error = await client
        .get('/reset-body', { retry: false })
        .catch((e) => e);
      expect(error).toBeInstanceOf(HttpNetworkError);
      expect(error.cause.code).toBe('UND_ERR_SOCKET');
      expect(toHttpException(error, { log: false })).toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('retries a timeout that fires while the body is read', async () => {
      failures['slow-body'] = 1;
      const client = new HttpClient({
        baseUrl: server.url,
        timeout: 100,
        retry,
      });
      await expect(client.get('/slow-body')).resolves.toMatchObject({
        data: { ok: true },
      });
      expect(server.requests).toHaveLength(2);
    });

    it('rejects invalid JSON with HttpParseError, whose message does not quote the body', async () => {
      const client = new HttpClient({ baseUrl: server.url, retry });
      const error = await client.get('/bad-json').catch((e) => e);
      expect(error).toBeInstanceOf(HttpParseError);
      expect(error).toBeInstanceOf(HttpClientError);
      expect(error).toMatchObject({
        status: 200,
        body: '<html>jane@example.com</html>',
      });
      expect(error.message).toBe(
        `GET ${server.url}/bad-json returned invalid JSON (200 OK)`,
      );
      expect(server.requests).toHaveLength(1); // not retried
      expect(toHttpException(error, { log: false })).toBeInstanceOf(
        BadGatewayException,
      );
    });

    it('reads the error body of a stream request under the timeout, instead of hanging', async () => {
      const client = new HttpClient({
        baseUrl: server.url,
        timeout: 100,
        retry: false,
      });
      const error = await client
        .get('/stalled-error', { responseType: 'stream' })
        .catch((e) => e);
      expect(error).toBeInstanceOf(HttpResponseError);
      expect(error.status).toBe(500);
      expect(error.body).toBeUndefined();
    }, 2_000);
  });

  it('refuses to send a stream body a second time, which would send it empty', async () => {
    failures.auth = 1;
    const resendOn401: HttpClientInterceptorFn = async (req, next) => {
      const res = await next(req);
      if (res.status !== 401) return res;
      await res.body?.cancel();
      return next(req);
    };
    const client = new HttpClient({
      baseUrl: server.url,
      interceptors: [resendOn401],
    });
    async function* chunks() {
      yield new TextEncoder().encode('payload');
    }
    const error = await client.put('/auth', { body: chunks() }).catch((e) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toContain('a stream can be sent only once');
    expect(server.requests.map((r) => r.body)).toEqual(['payload']);

    // A string, Buffer, Blob, FormData or URLSearchParams body is sent again as is
    failures.auth = 1;
    server.requests.length = 0;
    await expect(
      client.put('/auth', { body: 'payload' }),
    ).resolves.toMatchObject({ status: 200 });
    expect(server.requests.map((r) => r.body)).toEqual(['payload', 'payload']);
  });

  it('keeps url, headers and body out of inspect() and JSON.stringify(), but readable', () => {
    const error = new HttpResponseError({
      method: 'GET',
      url: 'https://api.example.com/users?token=s3cret',
      status: 500,
      headers: new Headers({ 'set-cookie': 'sid=abc' }),
      body: { email: 'jane@example.com' },
    });
    const wrapped = new BadGatewayException(undefined, { cause: error });
    for (const text of [
      inspect(error),
      JSON.stringify(error),
      inspect(wrapped),
    ]) {
      expect(text).not.toMatch(/s3cret|sid=abc|jane@example\.com/);
    }
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: 'HttpResponseError',
      method: 'GET',
      status: 500,
      statusText: '',
    });
    expect(error.url).toBe('https://api.example.com/users?token=s3cret');
    expect(error.headers.get('set-cookie')).toBe('sid=abc');
    expect(error.body).toEqual({ email: 'jane@example.com' });
  });

  it('rejects at once, before interceptors run, when the signal is already aborted', async () => {
    const intercept = vi.fn<HttpClientInterceptorFn>((req, next) => next(req));
    const client = new HttpClient({
      baseUrl: server.url,
      interceptors: [intercept],
    });
    const reason = new Error('the caller left');
    await expect(
      client.get('/', { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(intercept).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(0);
  });

  it('releases the responses an interceptor drops, so their connections are freed', async () => {
    const responses: Response[] = [];
    const fetch = async () => {
      responses.push(
        new Response('{}', { status: responses.length === 0 ? 401 : 200 }),
      );
      return responses.at(-1)!;
    };
    // Sends the request again after a 401 without cancelling the first response
    const careless: HttpClientInterceptorFn = async (req, next) => {
      const res = await next(req);
      return res.status === 401 ? next(req) : res;
    };
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      fetch,
      interceptors: [careless],
    });
    await expect(client.get('/x')).resolves.toMatchObject({ status: 200 });
    expect(responses.map((r) => r.bodyUsed)).toEqual([true, true]);

    // And when an interceptor throws after it got a response
    responses.length = 0;
    const throwing: HttpClientInterceptorFn = async (req, next) => {
      await next(req);
      throw new Error('bug in an interceptor');
    };
    const failing = new HttpClient({
      baseUrl: 'https://api.example.com',
      fetch,
      interceptors: [throwing],
    });
    await expect(failing.get('/x')).rejects.toThrow('bug in an interceptor');
    expect(responses.map((r) => r.bodyUsed)).toEqual([true]);
  });

  it('keeps the body of a response an interceptor wraps with new Response(res.body)', async () => {
    const addHeader: HttpClientInterceptorFn = async (req, next) => {
      const res = await next(req);
      const headers = new Headers(res.headers);
      headers.set('x-cache', 'miss');
      return new Response(res.body, { status: res.status, headers });
    };
    const client = new HttpClient({
      baseUrl: server.url,
      interceptors: [addHeader],
    });
    const res = await client.get<{ url: string }>('/wrapped');
    expect(res.headers.get('x-cache')).toBe('miss');
    expect(res.data.url).toBe('/wrapped');

    // A clone is a separate branch of the body: releasing the original leaves it intact
    const cloning = new HttpClient({
      baseUrl: server.url,
      interceptors: [async (req, next) => (await next(req)).clone()],
    });
    expect((await cloning.get<{ url: string }>('/cloned')).data.url).toBe(
      '/cloned',
    );
  });

  it('says what went wrong when an interceptor forgets to return the response', async () => {
    const forgetful = (async (req: HttpRequest, next: HttpHandler) => {
      await next(req);
    }) as unknown as HttpClientInterceptorFn;
    const client = new HttpClient({
      baseUrl: server.url,
      interceptors: [forgetful],
    });
    await expect(client.get('/')).rejects.toThrow(
      'The request resolved to undefined instead of a Response. An interceptor must return what ' +
        'next() resolves to (`return next(request)`)',
    );
  });

  it('refuses credentials an interceptor put in the URL, without echoing them', async () => {
    const basicAuth: HttpClientInterceptorFn = (req, next) => {
      req.url.username = 'user';
      req.url.password = 's3cret';
      return next(req);
    };
    const client = new HttpClient({
      baseUrl: server.url,
      interceptors: [basicAuth],
    });
    const error = await client.get('/').catch((e) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe(
      `"${server.url}/" includes credentials, which fetch rejects. Send them in the \`authorization\` header.`,
    );
    expect(server.requests).toHaveLength(0);
  });

  it('returns a non-2xx body that is not valid JSON as text with throwOnHttpError: false', async () => {
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      throwOnHttpError: false,
      fetch: async () =>
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'application/json' },
        }),
      retry: false,
    });
    await expect(client.get('/x')).resolves.toMatchObject({
      ok: false,
      status: 502,
      data: '<html>502 Bad Gateway</html>',
    });
  });

  it('fails when the client is created if an interceptor entry is not an interceptor', () => {
    expect(
      () => new HttpClient({ interceptors: [undefined as never] }),
    ).toThrow(
      'HttpClient `interceptors[0]` is undefined: expected a function, an object with intercept(), ' +
        'or a class that implements HttpClientInterceptor. An undefined entry usually means a circular import.',
    );
  });

  it('streams a large response as a Node Readable', async () => {
    const client = new HttpClient({ baseUrl: server.url });
    const res = await client.get('/large', { responseType: 'stream' });
    const hash = createHash('sha256');
    let bytes = 0;
    await pipeline(
      res.data,
      new Writable({
        write(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          hash.update(chunk);
          cb();
        },
      }),
    );
    expect(bytes).toBe(16 * 1024 * 1024);
    expect(hash.digest('hex')).toBe(
      createHash('sha256')
        .update(Buffer.alloc(16 * 1024 * 1024, 7))
        .digest('hex'),
    );
  });

  it('applies the timeout to stream headers only, not the download', async () => {
    const client = new HttpClient({ baseUrl: server.url, timeout: 150 });
    const res = await client.get('/slow-stream', { responseType: 'stream' });
    let text = '';
    for await (const chunk of res.data) text += chunk;
    expect(text).toBe('chunk0;chunk1;chunk2;chunk3;');
  });

  it('accepts a custom fetch, e.g. a stub in unit tests', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      headers: { authorization: 'Bearer t' },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({ id: 1 }, { status: 201 });
      },
    });
    const res = await client.post<{ id: number }>('/things', {
      json: { a: 1 },
    });
    expect(res).toMatchObject({
      status: 201,
      data: { id: 1 },
      url: 'https://api.example.com/things',
    });
    expect(calls[0].url).toBe('https://api.example.com/things');
    expect(new Headers(calls[0].init?.headers).get('authorization')).toBe(
      'Bearer t',
    );
    expect(calls[0].init?.body).toBe('{"a":1}');
  });

  it('loses authorization and cookie on a redirect to another origin, but not other headers', async () => {
    // What the README's advice on `redirect: 'error'` rests on: fetch's own behavior
    const other = await startServer(echo);
    const redirecting = await startServer((req, res) => {
      res.writeHead(302, { location: `${other.url}/landing` });
      res.end();
    });
    try {
      const client = new HttpClient({
        baseUrl: redirecting.url,
        headers: {
          authorization: 'Bearer t0k',
          cookie: 'sid=1',
          'x-api-key': 'k3y',
        },
      });
      const { data } = await client.get<{ headers: Record<string, string> }>(
        '/go',
      );
      expect(data.headers.authorization).toBeUndefined();
      expect(data.headers.cookie).toBeUndefined();
      expect(data.headers['x-api-key']).toBe('k3y');
    } finally {
      await other.close();
      await redirecting.close();
    }
  });

  it('passes `dispatcher` and `redirect` to fetch, per client or per request', async () => {
    const inits: (RequestInit & { dispatcher?: unknown })[] = [];
    const dispatcher = { dispatch: () => true };
    const client = new HttpClient({
      baseUrl: 'https://api.example.com',
      dispatcher,
      fetch: async (_url, init) => (
        inits.push(init!),
        new Response(null, { status: 204 })
      ),
    });
    await client.get('/a');
    await client.get('/b', { redirect: 'manual' });
    expect(inits[0]).toMatchObject({ dispatcher });
    expect(inits[0].redirect).toBeUndefined();
    expect(inits[1]).toMatchObject({ dispatcher, redirect: 'manual' });
  });

  describe('request validation', () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 204 }),
    );
    const client = new HttpClient({
      baseUrl: 'https://api.example.com/v1',
      fetch,
    });
    beforeEach(() => fetch.mockClear());

    it('fills /:name segments, and leaves colons elsewhere alone', async () => {
      await client.post('/projects/:project/documents:batchGet', {
        params: { project: 'p 1' },
      });
      await new HttpClient({ fetch }).get('http://localhost:8080/items/:id', {
        params: { id: 7 },
      });
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.example.com/v1/projects/p%201/documents:batchGet',
        'http://localhost:8080/items/7',
      ]);
    });

    it('rejects a params key without a matching segment, as axios users would pass a query', async () => {
      await expect(
        client.get('/users', { params: { page: 2 } }),
      ).rejects.toThrow(
        'No ":page" segment in "/users" for path parameter "page". Query-string values go in `query`.',
      );
      await expect(client.get('/users/:id', { params: {} })).rejects.toThrow(
        'Missing path parameter "id" for "/users/:id"',
      );
      await expect(client.get('/users/:id')).rejects.toThrow(
        'Missing path parameter "id" for "/users/:id": pass it in `params`',
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects a GET body and a relative URL without baseUrl before sending anything', async () => {
      await expect(
        client.get('/search', { json: { q: 'nest' } }),
      ).rejects.toThrow("A GET request can't have a body");
      await expect(new HttpClient({ fetch }).get('/users')).rejects.toThrow(
        '"/users" is a relative URL, and the client has no `baseUrl`',
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it('rejects path parameters that would move the request to another endpoint', async () => {
      for (const id of ['..', '.', '']) {
        await expect(
          client.get('/invoices/:id/pdf', { params: { id } }),
        ).rejects.toThrow(
          `Path parameter "id" can't be ${id ? `"${id}"` : 'empty'}: it would change which endpoint`,
        );
      }
      await expect(
        client.get('/invoices/:id', { params: { id: '\uD800' } }),
      ).rejects.toThrow('Path parameter "id" is not well-formed Unicode');
      expect(fetch).not.toHaveBeenCalled();
      // Dots and slashes inside a value are only characters
      await client.get('/invoices/:id', { params: { id: '../admin' } });
      expect(String(fetch.mock.calls[0][0])).toBe(
        'https://api.example.com/v1/invoices/..%2Fadmin',
      );
    });

    it("sends absolute URLs only to the base URL's origin, so credentials stay with their host", async () => {
      await client.get('https://api.example.com/v2/orders?page=2'); // same origin: a pagination link
      await expect(
        client.get('https://evil.example/collect?token=abc'),
      ).rejects.toThrow(
        '"https://evil.example/collect?token=***" is not on the client\'s origin (https://api.example.com).',
      );
      await expect(client.get('http://api.example.com/v1/x')).rejects.toThrow(
        /not on the client's origin/,
      );
      await expect(client.get('data:application/json,{}')).rejects.toThrow(
        'is not an http: or https: URL',
      );
      // A client without a baseUrl takes any http(s) URL
      await new HttpClient({ fetch }).get('https://other.example/ok');
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        'https://api.example.com/v2/orders?page=2',
        'https://other.example/ok',
      ]);
    });

    it('validates baseUrl when the client is created', () => {
      expect(() => new HttpClient({ baseUrl: 'api.example.com' })).toThrow(
        'HttpClient `baseUrl`: "api.example.com" is not an absolute URL. Include the scheme, e.g. "https://api.example.com".',
      );
      expect(
        () => new HttpClient({ baseUrl: 'https://api.example.com/v1?key=abc' }),
      ).toThrow(
        'HttpClient `baseUrl`: "https://api.example.com/v1?key=***" can\'t have a query string or fragment.',
      );
      expect(
        () => new HttpClient({ baseUrl: 'ftp://files.example.com' }),
      ).toThrow('is not an http: or https: URL');
      const withCredentials = (() => {
        try {
          return new HttpClient({
            baseUrl: 'https://user:s3cret@api.example.com',
          });
        } catch (error) {
          return error as Error;
        }
      })();
      expect(withCredentials).toBeInstanceOf(TypeError);
      expect((withCredentials as Error).message).toBe(
        'HttpClient `baseUrl`: "https://api.example.com/" includes credentials, which fetch rejects. ' +
          'Send them in the `authorization` header.',
      );
    });

    it('rejects an invalid header value without echoing it, since values are often credentials', async () => {
      const error = await client
        .get('/x', {
          headers: { authorization: 'Bearer s3cret\r\nx-injected: 1' },
        })
        .catch((e) => e);
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe(
        'Invalid value for the "authorization" header: it contains a line break or NUL',
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    it("takes headers from a Headers-like object of another class, such as undici's own", async () => {
      const foreign = {
        forEach: (callback: (value: string, key: string) => void) =>
          callback('from-undici', 'x-foreign'),
        get: () => null,
        has: () => false,
      } as unknown as Headers;
      await client.get('/x', { headers: foreign });
      expect(
        new Headers(fetch.mock.calls[0][1]?.headers).get('x-foreign'),
      ).toBe('from-undici');
    });
  });
});

describe('toHttpException', () => {
  const upstream = new HttpResponseError({
    method: 'GET',
    url: 'https://x/y',
    status: 404,
    statusText: 'Not Found',
    body: { message: 'nope' },
  });

  afterEach(() => vi.restoreAllMocks());

  it('maps upstream failures to 502/504 with the original error as cause', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const mapped = toHttpException(upstream);
    expect(mapped).toBeInstanceOf(BadGatewayException);
    expect(mapped.cause).toBe(upstream);
    expect(
      toHttpException(
        new HttpTimeoutError({
          method: 'GET',
          url: 'https://x',
          timeoutMs: 10,
        }),
      ),
    ).toBeInstanceOf(GatewayTimeoutException);
    expect(
      toHttpException(
        new HttpNetworkError({
          method: 'GET',
          url: 'https://x',
          cause: new Error(),
        }),
      ),
    ).toBeInstanceOf(BadGatewayException);
  });

  it('logs what it maps to a 5xx, since Nest does not log HttpExceptions', () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const upstream503 = new HttpResponseError({
      method: 'GET',
      url: 'https://x/y?token=s3cret',
      status: 503,
      statusText: 'Service Unavailable',
    });
    toHttpException(upstream503);
    toHttpException(
      new HttpTimeoutError({
        method: 'GET',
        url: 'https://x/y',
        timeoutMs: 10,
      }),
    );
    expect(logged.mock.calls).toEqual([
      [
        'GET https://x/y?token=*** failed with 503 Service Unavailable; answering 502 Bad Gateway',
      ],
      ['GET https://x/y timed out after 10ms; answering 504 Gateway Timeout'],
    ]);

    // Not logged: forwarded 4xx and `log: false`
    logged.mockClear();
    toHttpException(upstream, { forward: [404] });
    toHttpException(upstream503, { log: false });
    expect(logged).not.toHaveBeenCalled();
  });

  it('returns any other error unchanged, so Nest and other packages still handle it', () => {
    const logged = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const bug = new TypeError('Cannot read properties of undefined');
    const disconnect = new HttpException('Client Closed Request', 499);
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(toHttpException(bug)).toBe(bug);
    expect(toHttpException(disconnect)).toBe(disconnect);
    expect(toHttpException(abort)).toBe(abort);
    expect(logged).not.toHaveBeenCalled();
  });

  it('maps a DOMException TimeoutError (e.g. an AbortSignal.timeout deadline) to 504', () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const deadline = new DOMException(
      'The operation was aborted due to timeout',
      'TimeoutError',
    );
    const mapped = toHttpException(deadline) as HttpException;
    expect(mapped).toBeInstanceOf(GatewayTimeoutException);
    expect(mapped.cause).toBe(deadline);
  });

  it('forwards selected upstream statuses with their body', () => {
    const mapped = toHttpException(upstream, { forward: [404] });
    expect(mapped).toBeInstanceOf(HttpException);
    expect(mapped.getStatus()).toBe(404);
    expect(mapped.getResponse()).toEqual({ message: 'nope' });
  });
});
