/**
 * #1568: what a host URL's health probe found, for `pyric run --sandbox`.
 * A sandbox host answers `/__pyric/health` with 200 and its JSON health
 * reply (`bridge.health()`, `mode: 'sandbox'`), or 503 while its mount is
 * closing. Any other answer comes from a server that is not a sandbox host,
 * such as an in-page Vite server, which answers 404 to a JSON request and its
 * index.html to a browser.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { probeHostUrlAnswer, servesViteClient } from '../../src/serve/discovery.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
});

async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const HEALTH = { status: 'ok', mode: 'sandbox', project: 'demo', sandboxConnected: false, version: '0', startedAt: '', instanceId: 'abc' };

function answersHealth(status: number, body: string, type = 'application/json'): RequestListener {
  return (req, res) => {
    const isHealth = req.url === '/__pyric/health';
    if (isHealth) res.writeHead(status, { 'content-type': type }).end(body);
    else res.writeHead(404).end();
  };
}

describe('probeHostUrlAnswer', () => {
  it('reports a sandbox host from its health reply', async () => {
    const url = await serve(answersHealth(200, JSON.stringify(HEALTH)));
    expect(await probeHostUrlAnswer(url)).toEqual({ kind: 'host', host: { base: url, instanceId: 'abc' } });
  });

  it('reports no answer when nothing listens yet', async () => {
    const url = await serve(answersHealth(200, '{}'));
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
    expect(await probeHostUrlAnswer(url)).toEqual({ kind: 'no-answer' });
  });

  it('reports no answer from a host whose mount is closing', async () => {
    const url = await serve(answersHealth(503, JSON.stringify({ error: 'pyric bridge: mount is closed' })));
    expect(await probeHostUrlAnswer(url)).toEqual({ kind: 'no-answer' });
  });

  it('reports a server that answers 404, as an in-page Vite server does', async () => {
    const url = await serve(answersHealth(404, ''));
    expect(await probeHostUrlAnswer(url)).toEqual({ kind: 'not-a-host', base: url });
  });

  it('reports a server that answers with a page instead of the health reply', async () => {
    const url = await serve(answersHealth(200, '<!doctype html><html></html>', 'text/html'));
    expect(await probeHostUrlAnswer(url)).toEqual({ kind: 'not-a-host', base: url });
  });

  it('reports a server whose JSON is not a sandbox health reply', async () => {
    const url = await serve(answersHealth(200, JSON.stringify({ status: 'ok' })));
    expect(await probeHostUrlAnswer(url)).toEqual({ kind: 'not-a-host', base: url });
  });

  it('reports HTTP 403 as host-refused with plain-text, JSON, or empty reply details', async () => {
    const plain = await serve(
      answersHealth(403, "pyric sandbox: refused request for Host '0.0.0.0:4330'.", 'text/plain'),
    );
    expect(await probeHostUrlAnswer(plain)).toEqual({
      kind: 'host-refused',
      base: plain,
      detail: "pyric sandbox: refused request for Host '0.0.0.0:4330'.",
    });

    const json = await serve(
      answersHealth(403, JSON.stringify({ error: 'Forbidden: this route answers clients on this machine only' })),
    );
    expect(await probeHostUrlAnswer(json)).toEqual({
      kind: 'host-refused',
      base: json,
      detail: 'Forbidden: this route answers clients on this machine only',
    });

    const empty = await serve(answersHealth(403, '', 'text/plain'));
    expect(await probeHostUrlAnswer(empty)).toEqual({
      kind: 'host-refused',
      base: empty,
      detail: '',
    });

    const problemJson = await serve(
      answersHealth(403, JSON.stringify({ error: 'Blocked\n\u001b[31mHost\u001b[0m\u0007' }), 'application/problem+json; charset=utf-8'),
    );
    expect(await probeHostUrlAnswer(problemJson)).toEqual({
      kind: 'host-refused',
      base: problemJson,
      detail: 'Blocked Host',
    });
  });

  it('omits HTML, XML, binary, and non-error JSON 403 bodies and strips control characters from plain text', async () => {
    const html = await serve(
      answersHealth(403, '<!doctype html><html><body><h1>403 Forbidden</h1></body></html>', 'text/html; charset=utf-8'),
    );
    expect(await probeHostUrlAnswer(html)).toEqual({ kind: 'host-refused', base: html, detail: '' });

    const xhtml = await serve(
      answersHealth(403, '<html><body>Forbidden</body></html>', 'application/xhtml+xml'),
    );
    expect(await probeHostUrlAnswer(xhtml)).toEqual({ kind: 'host-refused', base: xhtml, detail: '' });

    const headerlessHtml = await serve((req, res) => {
      if (req.url === '/__pyric/health') {
        res.statusCode = 403;
        res.end('<!DOCTYPE html><html><body>Access denied</body></html>');
      } else {
        res.writeHead(404).end();
      }
    });
    expect(await probeHostUrlAnswer(headerlessHtml)).toEqual({ kind: 'host-refused', base: headerlessHtml, detail: '' });

    const headerlessPlain = await serve((req, res) => {
      if (req.url === '/__pyric/health') {
        res.statusCode = 403;
        res.end("pyric: refused request for Host '0.0.0.0:5173' (DNS-rebinding guard).");
      } else {
        res.writeHead(404).end();
      }
    });
    expect(await probeHostUrlAnswer(headerlessPlain)).toEqual({
      kind: 'host-refused',
      base: headerlessPlain,
      detail: "pyric: refused request for Host '0.0.0.0:5173' (DNS-rebinding guard).",
    });

    const multilinePlain = await serve(
      answersHealth(
        403,
        'Blocked request. This host ("0.0.0.0") is not allowed.\n\u001b[31mTo allow this host\u001b[0m, update server.allowedHosts.\u0000\u0085',
        'text/plain; charset=utf-8',
      ),
    );
    expect(await probeHostUrlAnswer(multilinePlain)).toEqual({
      kind: 'host-refused',
      base: multilinePlain,
      detail: 'Blocked request. This host ("0.0.0.0") is not allowed. To allow this host, update server.allowedHosts.',
    });

    const jsonNoError = await serve(
      answersHealth(403, JSON.stringify({ status: 403, code: 'DENIED' }), 'application/json'),
    );
    expect(await probeHostUrlAnswer(jsonNoError)).toEqual({ kind: 'host-refused', base: jsonNoError, detail: '' });

    const jsonInvalid = await serve(answersHealth(403, '{not-json', 'application/json'));
    expect(await probeHostUrlAnswer(jsonInvalid)).toEqual({ kind: 'host-refused', base: jsonInvalid, detail: '' });
  });
});

describe('servesViteClient', () => {
  it('is true for a server that serves /@vite/env', async () => {
    const url = await serve((req, res) => {
      const isViteEnv = req.url === '/@vite/env';
      if (isViteEnv) res.writeHead(200, { 'content-type': 'text/javascript' }).end('export {}');
      else res.writeHead(404).end();
    });
    expect(await servesViteClient(url)).toBe(true);
  });

  it('waits past the 1s health-probe deadline for a cold /@vite/env transform', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/@vite/env') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/javascript' }).end('export const env = {};');
        }, 1_200);
      } else {
        res.writeHead(404).end();
      }
    });
    expect(await servesViteClient(url)).toBe(true);
  });

  it('is false when /@vite/env exceeds its deadline', async () => {
    const url = await serve((req, res) => {
      if (req.url === '/@vite/env') {
        const timer = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/javascript' }).end('export {}');
        }, 500);
        req.on('close', () => clearTimeout(timer));
      } else {
        res.writeHead(404).end();
      }
    });
    expect(await servesViteClient(url, 80)).toBe(false);
  });

  it('is false for any other server', async () => {
    const url = await serve(answersHealth(404, ''));
    expect(await servesViteClient(url)).toBe(false);
  });
});
