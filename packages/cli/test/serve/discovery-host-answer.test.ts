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

  it('is false for any other server', async () => {
    const url = await serve(answersHealth(404, ''));
    expect(await servesViteClient(url)).toBe(false);
  });
});
