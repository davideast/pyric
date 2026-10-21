/**
 * The bounded loopback request that discovery probes and the register beacon
 * share: everything it does ends at its deadline or its body cap.
 */
import { describe, expect, it } from 'bun:test';
import { createServer, type RequestListener, type Server } from 'node:http';
import { boundedRequest, getJsonWithin, MAX_RESPONSE_BYTES } from '../src/bounded-request.js';
import { closedPort } from './closed-port.js';

async function serve(listener: RequestListener): Promise<{ server: Server; base: string }> {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { server, base: `http://127.0.0.1:${port}` };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('getJsonWithin', () => {
  it('returns the parsed body of a 200 response', async () => {
    const { server, base } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"mode":"sandbox"}');
    });
    try {
      expect(await getJsonWithin(`${base}/__pyric/health`, 1_000)).toEqual({ body: { mode: 'sandbox' } });
    } finally {
      await close(server);
    }
  });

  it('returns null for a non-200 status and for a body that is not JSON', async () => {
    const { server, base } = await serve((req, res) => {
      if (req.url === '/missing') res.writeHead(404).end('{}');
      else res.writeHead(200).end('not json');
    });
    try {
      expect(await getJsonWithin(`${base}/missing`, 1_000)).toBeNull();
      expect(await getJsonWithin(`${base}/text`, 1_000)).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('does not follow a redirect', async () => {
    const { server, base } = await serve((req, res) => {
      if (req.url === '/moved') res.writeHead(302, { location: '/here' }).end();
      else res.writeHead(200).end('{"mode":"sandbox"}');
    });
    try {
      expect(await getJsonWithin(`${base}/moved`, 1_000)).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('gives up on a body past the cap instead of buffering it', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    let socketClosed = false;
    const { server, base } = await serve((req, res) => {
      req.socket.once('close', () => { socketClosed = true; });
      res.writeHead(200, { 'content-type': 'application/json' });
      const pump = (): void => {
        while (!res.destroyed && res.write(chunk)) { /* fill until backpressure */ }
        if (!res.destroyed) res.once('drain', pump);
      };
      pump();
    });
    try {
      const started = performance.now();
      const result = await getJsonWithin(`${base}/endless`, 10_000);
      expect(result).toBeNull();
      expect(performance.now() - started).toBeLessThan(2_000);
      const closedBy = Date.now() + 2_000;
      while (!socketClosed && Date.now() < closedBy) await new Promise((r) => setTimeout(r, 10));
      expect(socketClosed).toBe(true);
    } finally {
      await close(server);
    }
  });

  it('speaks TLS for an https url', async () => {
    // A plain http server cannot complete a TLS handshake, so the https branch
    // fails fast rather than reading the plaintext answer.
    const { server, base } = await serve((_req, res) => {
      res.writeHead(200).end('{"mode":"sandbox"}');
    });
    try {
      const started = performance.now();
      expect(await getJsonWithin(`${base.replace('http:', 'https:')}/__pyric/health`, 5_000)).toBeNull();
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      await close(server);
    }
  });

  it('returns null for an unparseable url and a refused port', async () => {
    expect(await getJsonWithin('not a url', 1_000)).toBeNull();
    expect(await getJsonWithin(`http://127.0.0.1:${await closedPort()}/`, 1_000)).toBeNull();
  });
});

describe('boundedRequest', () => {
  it('sends a POST body with its headers and reports the status', async () => {
    let received = '';
    const { server, base } = await serve((req, res) => {
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { received += chunk; });
      req.on('end', () => res.writeHead(204, { 'x-seen': String(req.headers['x-token']) }).end());
    });
    try {
      const response = await boundedRequest(`${base}/beacon`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-token': 'secret' },
        body: '{"pid":1}',
        deadlineMs: 1_000,
      });
      expect(response?.status).toBe(204);
      expect(received).toBe('{"pid":1}');
    } finally {
      await close(server);
    }
  });

  it('caps the body at MAX_RESPONSE_BYTES', async () => {
    const { server, base } = await serve((_req, res) => {
      res.writeHead(200).end(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20));
    });
    try {
      expect(await boundedRequest(`${base}/`, { deadlineMs: 1_000 })).toBeNull();
    } finally {
      await close(server);
    }
  });
});
