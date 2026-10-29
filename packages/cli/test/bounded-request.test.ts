/**
 * The bounded loopback request that discovery probes, the register beacon,
 * and the CLI's other local probes share: everything it does ends at its
 * deadline, its abort signal, or its body cap.
 */
import { describe, expect, it } from 'bun:test';
import { createServer, type RequestListener, type Server } from 'node:http';
import { boundedFetch, boundedRequest, getJsonWithin, MAX_RESPONSE_BYTES } from '../src/bounded-request.js';
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

  it('reads past MAX_RESPONSE_BYTES up to its own maxBytes', async () => {
    const { server, base } = await serve((_req, res) => {
      res.writeHead(200).end(Buffer.alloc(MAX_RESPONSE_BYTES + 1, 0x20));
    });
    try {
      const response = await boundedRequest(`${base}/`, { deadlineMs: 1_000, maxBytes: Number.POSITIVE_INFINITY });
      expect(response?.body.length).toBe(MAX_RESPONSE_BYTES + 1);
    } finally {
      await close(server);
    }
  });

  it('ends at an aborted signal before the deadline', async () => {
    const { server, base } = await serve(() => {
      // Never answers.
    });
    try {
      const controller = new AbortController();
      const started = performance.now();
      const pending = boundedRequest(`${base}/`, { deadlineMs: 10_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);
      expect(await pending).toBeNull();
      expect(performance.now() - started).toBeLessThan(2_000);
      expect(await boundedRequest(`${base}/`, { deadlineMs: 10_000, signal: AbortSignal.abort() })).toBeNull();
    } finally {
      await close(server);
    }
  });
});

describe('boundedFetch', () => {
  it('resolves a Response with the status, headers, and body', async () => {
    const { server, base } = await serve((req, res) => {
      res.writeHead(201, { 'content-type': 'application/json', 'x-pyric-project-dir': '/app', 'x-seen': String(req.headers['x-token']) })
        .end('{"version":1}');
    });
    try {
      const response = await boundedFetch(`${base}/state`, { headers: { 'x-token': 'secret' }, deadlineMs: 1_000 });
      expect(response.status).toBe(201);
      expect(response.ok).toBe(true);
      expect(response.headers.get('x-pyric-project-dir')).toBe('/app');
      expect(response.headers.get('x-seen')).toBe('secret');
      expect(await response.json()).toEqual({ version: 1 });
    } finally {
      await close(server);
    }
  });

  it('returns a redirect as its own status, or rejects it under redirect error', async () => {
    const { server, base } = await serve((_req, res) => {
      res.writeHead(302, { location: '/elsewhere' }).end();
    });
    try {
      expect((await boundedFetch(`${base}/`, { deadlineMs: 1_000 })).status).toBe(302);
      await expect(boundedFetch(`${base}/`, { deadlineMs: 1_000, redirect: 'error' })).rejects.toBeInstanceOf(TypeError);
    } finally {
      await close(server);
    }
  });

  it('gives a null-body status a null body', async () => {
    const { server, base } = await serve((_req, res) => {
      res.writeHead(204).end();
    });
    try {
      const response = await boundedFetch(`${base}/`, { deadlineMs: 1_000 });
      expect(response.status).toBe(204);
      expect(response.body).toBeNull();
    } finally {
      await close(server);
    }
  });

  it('rejects with a TypeError where the request gives up', async () => {
    await expect(boundedFetch(`http://127.0.0.1:${await closedPort()}/`, { deadlineMs: 1_000 })).rejects.toBeInstanceOf(TypeError);
  });
});
