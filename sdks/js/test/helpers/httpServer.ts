/** Local HTTP API used as the "real network" in fetch / XHR tests. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestServer {
  url: string;
  port: number;
  hits: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }>;
  close(): Promise<void>;
}

export const USERS_JSON = JSON.stringify({ users: [{ id: 1, name: 'Ali' }, { id: 2, name: 'Ayşe' }] });
export const BINARY = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

export function startHttpServer(): Promise<TestServer> {
  const hits: TestServer['hits'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url || '/', 'http://localhost');
      hits.push({ method: req.method || 'GET', path: url.pathname + url.search, headers: req.headers, body });
      const route = url.pathname;
      if (route === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': 'abc-123' });
        res.end(USERS_JSON);
      } else if (route === '/echo') {
        res.writeHead(201, { 'Content-Type': req.headers['content-type'] || 'application/octet-stream', 'X-Echo-Method': req.method || '' });
        res.end(body);
      } else if (route === '/binary') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(BINARY.length) });
        res.end(BINARY);
      } else if (route.startsWith('/status/')) {
        const code = Number(route.slice('/status/'.length)) || 500;
        res.writeHead(code, { 'Content-Type': 'text/plain' });
        res.end(`status ${code}`);
      } else if (route === '/slow') {
        const ms = Number(url.searchParams.get('ms') || '300');
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('slow ok');
        }, ms);
      } else if (route === '/big') {
        const n = Number(url.searchParams.get('n') || '1000');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': String(n) });
        res.end('a'.repeat(n));
      } else if (route === '/sse') {
        // An event stream that stays open (the client closes it).
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: merhaba\n\n');
        const timer = setInterval(() => res.write(': ping\n\n'), 200);
        res.on('close', () => clearInterval(timer));
      } else if (route === '/nocontent') {
        res.writeHead(204);
        res.end();
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        hits,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

/** A port with nothing listening (connection refused). */
export async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}
