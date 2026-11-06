/**
 * Under `pyric sandbox -- next dev`, `withPyric`'s rewrite forwards a page's
 * `/__pyric/*` writes with the Next origin. The guarded routes accept that
 * origin once `pyric sandbox` has learned the Next port (#1194), and still
 * refuse a page on any other local port.
 */
import { expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAppPorts, type AppPorts } from '../../src/serve/app-ports.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer } from '../../src/serve/server.js';

const NEXT_PORT = 3921;

/** A same-origin request the rewrite forwarded from the Next page. */
function forwardedFromNext(): IncomingMessage {
  const headers = { 'sec-fetch-site': 'same-origin', 'x-forwarded-host': `127.0.0.1:${NEXT_PORT}` };
  return { headers, socket: { localPort: 0 } } as unknown as IncomingMessage;
}

async function withServer(appPorts: AppPorts | undefined, run: (url: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pyric-proxy-origin-'));
  const namespace = createPyricNamespace({
    sdkDir: root,
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    appPorts,
  });
  const server = await startStaticServer({ publicDir: root, port: 0, host: '127.0.0.1', namespaceHandler: namespace, logger: silentServeLogger() });
  try {
    await run(server.url);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}

async function postDiagnostics(url: string, origin: string): Promise<number> {
  const response = await fetch(`${url}/__pyric/diagnostics`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ version: 1, clientId: 'page', sequence: 1, realm: 'page', pageOrigin: origin, events: [{ at: 1, phase: 'connecting', connectionId: 'socket-1' }] }),
  });
  await response.arrayBuffer();
  return response.status;
}

test('a guarded route accepts the Next origin once the proxy port is learned', async () => {
  const appPorts = createAppPorts('localhost');
  appPorts.learn(forwardedFromNext());
  await withServer(appPorts, async (url) => {
    expect(await postDiagnostics(url, `http://127.0.0.1:${NEXT_PORT}`)).toBe(204);
  });
});

test('a guarded route still refuses a page on another local port', async () => {
  const appPorts = createAppPorts('localhost');
  appPorts.learn(forwardedFromNext());
  await withServer(appPorts, async (url) => {
    expect(await postDiagnostics(url, 'http://127.0.0.1:4000')).toBe(403);
  });
});

test('a guarded route accepts the server\'s own port with learned ports', async () => {
  const appPorts = createAppPorts('localhost');
  await withServer(appPorts, async (url) => {
    expect(await postDiagnostics(url, url)).toBe(204);
  });
});

async function postDenial(url: string, origin: string): Promise<number> {
  const body = { kind: 'read', method: 'get', path: '/databases/(default)/documents/notes/a', message: 'denied from next' };
  const response = await fetch(`${url}/__pyric/denials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  return response.status;
}

test('the denials route accepts the Next origin once the proxy port is learned', async () => {
  const appPorts = createAppPorts('localhost');
  appPorts.learn(forwardedFromNext());
  await withServer(appPorts, async (url) => {
    expect(await postDenial(url, `http://127.0.0.1:${NEXT_PORT}`)).toBe(204);
    expect(await postDenial(url, 'http://127.0.0.1:4000')).toBe(403);
  });
});

test('without app ports, as under the Vite plugin, a guarded route refuses the Next origin', async () => {
  await withServer(undefined, async (url) => {
    expect(await postDiagnostics(url, `http://127.0.0.1:${NEXT_PORT}`)).toBe(403);
  });
});
