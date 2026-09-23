import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  /** Requests received so far, with their raw body. */
  requests: {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }[];
  close(): Promise<void>;
}

/** A local node:http server on an ephemeral port. `handler` sees the buffered body. */
export async function startServer(
  handler: (
    req: IncomingMessage & { body: string },
    res: ServerResponse,
  ) => unknown,
): Promise<TestServer> {
  const requests: TestServer['requests'] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: req.method!,
      url: req.url!,
      headers: req.headers,
      body,
    });
    try {
      await handler(Object.assign(req, { body }), res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Echoes method, path+query, selected headers and the parsed body. */
export function echo(
  req: IncomingMessage & { body: string },
  res: ServerResponse,
) {
  sendJson(res, 200, {
    method: req.method,
    url: req.url,
    headers: req.headers,
    body:
      req.headers['content-type']?.includes('json') && req.body
        ? JSON.parse(req.body)
        : req.body,
  });
}
