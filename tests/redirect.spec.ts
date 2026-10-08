import { Readable } from 'node:stream';
import { HttpClient, HttpNetworkError } from '../lib/index.js';
import { echo, startServer, type TestServer } from './server.js';

let other: TestServer;
let server: TestServer;

type Echo = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

beforeAll(async () => {
  other = await startServer(echo);
  server = await startServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const redirect = (status: number, location: string) => {
      res.writeHead(status, { location });
      res.end();
    };
    // /to/<status>?l=<location>
    if (url.pathname.startsWith('/to/')) {
      return redirect(
        Number(url.pathname.slice(4)),
        url.searchParams.get('l')!,
      );
    }
    // /hop/<n>: n more same-origin redirects, then echo
    if (url.pathname.startsWith('/hop/')) {
      const n = Number(url.pathname.slice(5));
      return n > 0 ? redirect(302, `/hop/${n - 1}`) : echo(req, res);
    }
    // /dir/relative → "sibling" resolves against the current URL, not the base
    if (url.pathname === '/dir/relative') return redirect(302, 'sibling');
    return echo(req, res);
  });
});

afterAll(async () => {
  await server.close();
  await other.close();
});

beforeEach(() => {
  server.requests.length = 0;
  other.requests.length = 0;
});

const to = (status: number, location: string) =>
  `/to/${status}?l=${encodeURIComponent(location)}`;

describe('redirects of a client with a baseUrl', () => {
  const headers = { authorization: 'Bearer t0k', 'x-api-key': 'k3y' };

  describe('to another origin', () => {
    it.each([301, 302, 303, 307, 308])(
      'fails a %i redirect with HttpNetworkError before anything reaches the other host',
      async (status) => {
        const client = new HttpClient({ baseUrl: server.url, headers });
        const error = await client
          .post(to(status, `${other.url}/landing`), { json: { iban: 'DE89' } })
          .catch((e) => e);
        expect(error).toBeInstanceOf(HttpNetworkError);
        expect(error.message).toMatch(
          /^POST .* failed: redirect to another origin .* refused/,
        );
        expect(other.requests).toHaveLength(0);
        expect(server.requests).toHaveLength(1);
      },
    );

    it('fails when a later hop leaves the origin', async () => {
      const client = new HttpClient({ baseUrl: server.url, headers });
      const path = to(302, to(302, `${other.url}/landing`));
      await expect(client.get(path)).rejects.toBeInstanceOf(HttpNetworkError);
      expect(server.requests).toHaveLength(2);
      expect(other.requests).toHaveLength(0);
    });

    it('also protects headers an interceptor added', async () => {
      const client = new HttpClient({
        baseUrl: server.url,
        interceptors: [
          (req, next) => (req.headers.set('x-token', 'secret'), next(req)),
        ],
      });
      await expect(
        client.get(to(302, `${other.url}/landing`)),
      ).rejects.toBeInstanceOf(HttpNetworkError);
      expect(other.requests).toHaveLength(0);
    });

    it('is not retried: it fails the same way every time', async () => {
      const client = new HttpClient({
        baseUrl: server.url,
        retry: { backoff: { delay: 1 } },
      });
      await expect(
        client.get(to(302, `${other.url}/landing`)),
      ).rejects.toBeInstanceOf(HttpNetworkError);
      expect(server.requests).toHaveLength(1);
    });

    it('is followed with an explicit `redirect: follow` (fetch drops authorization and cookie)', async () => {
      const client = new HttpClient({
        baseUrl: server.url,
        redirect: 'follow',
        headers: { ...headers, cookie: 'sid=1' },
      });
      const { data } = await client.get<Echo>(to(302, `${other.url}/landing`));
      expect(data.url).toBe('/landing');
      expect(data.headers.authorization).toBeUndefined();
      expect(data.headers.cookie).toBeUndefined();
      expect(data.headers['x-api-key']).toBe('k3y');
    });

    it('is followed by a client without a baseUrl, as fetch does', async () => {
      const client = new HttpClient();
      const { data } = await client.get<Echo>(
        `${server.url}${to(302, `${other.url}/landing`)}`,
      );
      expect(data.url).toBe('/landing');
    });
  });

  describe('on the same origin', () => {
    it('follows a redirect and keeps the headers; `url` is the final URL', async () => {
      const client = new HttpClient({ baseUrl: server.url, headers });
      const res = await client.get<Echo>(to(302, '/landing?x=1'));
      expect(res.status).toBe(200);
      expect(res.url).toBe(`${server.url}/landing?x=1`);
      expect(res.data.url).toBe('/landing?x=1');
      expect(res.data.headers.authorization).toBe('Bearer t0k');
      expect(res.data.headers['x-api-key']).toBe('k3y');
      expect(server.requests.map((r) => r.url)).toEqual([
        to(302, '/landing?x=1'),
        '/landing?x=1',
      ]);
    });

    it('resolves a relative location against the current URL, not the base', async () => {
      const client = new HttpClient({ baseUrl: server.url });
      const { data } = await client.get<Echo>('/dir/relative');
      expect(data.url).toBe('/dir/sibling');
    });

    it.each([301, 302, 303])(
      'turns a POST into a GET without a body on %i',
      async (status) => {
        const client = new HttpClient({ baseUrl: server.url });
        const { data } = await client.post<Echo>(to(status, '/landing'), {
          json: { a: 1 },
          headers: { 'x-custom': 'kept' },
        });
        expect(data.method).toBe('GET');
        expect(data.body).toBe('');
        expect(data.headers['content-type']).toBeUndefined();
        expect(data.headers['content-length']).toBeUndefined();
        expect(data.headers['x-custom']).toBe('kept');
      },
    );

    it('turns a PUT into a GET on 303 only', async () => {
      const client = new HttpClient({ baseUrl: server.url });
      const after303 = await client.put<Echo>(to(303, '/landing'), {
        json: { a: 1 },
      });
      expect(after303.data.method).toBe('GET');
      const after302 = await client.put<Echo>(to(302, '/landing'), {
        json: { a: 1 },
      });
      expect(after302.data).toMatchObject({ method: 'PUT', body: { a: 1 } });
    });

    it.each([307, 308])('keeps the method and body on %i', async (status) => {
      const client = new HttpClient({ baseUrl: server.url });
      const { data } = await client.post<Echo>(to(status, '/landing'), {
        json: { a: 1 },
      });
      expect(data).toMatchObject({ method: 'POST', body: { a: 1 } });
      expect(data.headers['content-type']).toBe('application/json');
    });

    it.each([307, 308])(
      'fails a %i redirect of a stream body instead of resending it empty',
      async (status) => {
        const client = new HttpClient({ baseUrl: server.url });
        const error = await client
          .post(to(status, '/landing'), { body: Readable.from(['chunk']) })
          .catch((e) => e);
        expect(error).toBeInstanceOf(HttpNetworkError);
        expect(error.message).toMatch(/would resend a stream body/);
        expect(server.requests).toHaveLength(1);
      },
    );

    it('follows up to 20 redirects, like fetch, and fails the 21st', async () => {
      const client = new HttpClient({ baseUrl: server.url });
      const { data } = await client.get<Echo>('/hop/20');
      expect(data.url).toBe('/hop/0');
      expect(server.requests).toHaveLength(21);
      server.requests.length = 0;
      const error = await client.get('/hop/21').catch((e) => e);
      expect(error).toBeInstanceOf(HttpNetworkError);
      expect(error.message).toMatch(/too many redirects/);
      expect(server.requests).toHaveLength(21);
    });

    it('refuses a location with credentials without quoting them', async () => {
      const client = new HttpClient({ baseUrl: server.url });
      const { host } = new URL(server.url);
      const error = await client
        .get(to(302, `http://user:s3cret@${host}/landing`))
        .catch((e) => e);
      expect(error).toBeInstanceOf(HttpNetworkError);
      expect(error.message).not.toContain('s3cret');
      expect(error.cause.message).not.toContain('s3cret');
      expect(server.requests).toHaveLength(1);
    });

    it('returns a 3xx without a location as the response', async () => {
      const client = new HttpClient({
        baseUrl: server.url,
        throwOnHttpError: false,
        fetch: async () => new Response(null, { status: 302 }),
      });
      const res = await client.get('/x');
      expect(res.status).toBe(302);
    });

    it('leaves `redirect: error` and `redirect: manual` to fetch', async () => {
      const client = new HttpClient({ baseUrl: server.url });
      await expect(
        client.get(to(302, '/landing'), { redirect: 'error' }),
      ).rejects.toBeInstanceOf(HttpNetworkError);
      const res = await client.get(to(302, '/landing'), {
        redirect: 'manual',
        throwOnHttpError: false,
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/landing');
    });
  });
});
