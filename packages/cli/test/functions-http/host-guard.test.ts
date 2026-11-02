/**
 * The DNS-rebinding guard on function routes under `pyric sandbox`: the
 * static server checks Host before it hands any request to the Functions
 * gateway, so a page that rebinds its hostname to 127.0.0.1 never reaches a
 * function. The Vite plane's half is in vite-plane.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createFunctionsHttpGateway } from '../../src/functions/http/gateway.js';
import { silentServeLogger, startStaticServer, type ServeHandle } from '../../src/serve/server.js';

const opened: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.stop();
});

function rawRequest(port: number, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolveCall, rejectCall) => {
    const outgoing = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolveCall({ status: response.statusCode ?? 0, body }));
    });
    outgoing.on('error', rejectCall);
    outgoing.end('x');
  });
}

async function fakeChild(onRequest: () => void): Promise<number> {
  const child: Server = createServer((_req, res) => { onRequest(); res.end('ran'); });
  opened.push({ stop: () => new Promise((resolveStop) => child.close(() => resolveStop())) });
  await new Promise<void>((resolveListen) => child.listen(0, '127.0.0.1', () => resolveListen()));
  return (child.address() as AddressInfo).port;
}

describe('function routes behind the pyric sandbox Host guard', () => {
  test('a foreign Host on the emulator path gets 403 and never reaches the child', async () => {
    let reached = 0;
    const childPort = await fakeChild(() => { reached += 1; });
    const gateway = createFunctionsHttpGateway({ projectId: 'demo-app', initial: { kind: 'starting' }, plane: 'pyric-sandbox' });
    gateway.update({
      kind: 'ready',
      http: { port: childPort, token: 't', functions: [{ exportName: 'api', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: null }] },
    });
    const handle: ServeHandle = await startStaticServer({
      publicDir: mkdtempSync(join(tmpdir(), 'pyric-host-guard-')),
      port: 0,
      host: 'localhost',
      logger: silentServeLogger(),
      functionsHandler: (req, res) => gateway.handle(req, res, () => true),
    });
    opened.push(handle);

    const rebound = await rawRequest(handle.port, '/demo-app/us-central1/api', { host: `attacker.example:${handle.port}` });
    expect(rebound.status).toBe(403);
    expect(rebound.body).toContain("refused request for Host 'attacker.example");
    expect(reached).toBe(0);

    const local = await rawRequest(handle.port, '/demo-app/us-central1/api', { host: `localhost:${handle.port}` });
    expect(local).toEqual({ status: 200, body: 'ran' });
    expect(reached).toBe(1);
  });
});
