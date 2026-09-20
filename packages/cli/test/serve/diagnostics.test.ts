import { runServeDiagnostics } from '../../src/cli/serve-diagnostics.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { silentServeLogger, startStaticServer } from '../../src/serve/server.js';

async function withServer(run: (url: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pyric-diagnostics-'));
  const namespace = createPyricNamespace({ sdkDir: root, initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null, hosted: true }) });
  const server = await startStaticServer({ publicDir: root, port: 0, host: '127.0.0.1', namespaceHandler: namespace, logger: silentServeLogger() });
  try { await run(server.url); }
  finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
}

const report = (clientId = 'test-browser') => ({
  version: 1, clientId, sequence: 2, realm: 'page',
  pageOrigin: 'https://orbit.example:8457',
  events: [
    { at: 100, phase: 'connecting', connectionId: 'socket-1', endpoint: 'wss://user:password@orbit.example:5217/__pyric/sandbox?token=secret#fragment' },
    { at: 101, phase: 'socket-close', connectionId: 'socket-1', code: 1006 },
  ],
});

test('HTTP diagnostics explain a proxy port failure without a sandbox WebSocket and redact URL secrets', () => withServer(async url => {
  const endpoint = `${url}/__pyric/diagnostics`;
  const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(report()) });
  expect(response.status).toBe(204);
  const result = await (await fetch(endpoint)).json();
  expect(result.server.http).toBe('responding');
  expect(result.server.mode).toBe('hosted');
  expect(result.clients[0].events[0].endpoint).toBe('wss://orbit.example:5217/__pyric/sandbox');
  expect(result.clients[0].findings).toContainEqual({ code: 'endpoint-origin-mismatch', connectionId: 'socket-1', expectedOrigin: 'wss://orbit.example:8457', actualOrigin: 'wss://orbit.example:5217' });
  expect(JSON.stringify(result)).not.toMatch(/password|token=|secret|fragment/);
}));

test('diagnostics reject cross-origin and oversized input, bound retention, and ignore stale reports', () => withServer(async url => {
  const endpoint = `${url}/__pyric/diagnostics`;
  const post = (body: unknown, extra: Record<string, string> = {}) => fetch(endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
  });
  expect((await post(report(), { origin: 'https://untrusted.example' })).status).toBe(403);
  expect((await post({ padding: 'x'.repeat(20_000) })).status).toBe(413);
  expect((await post({ ...report(), events: Array(33).fill(report().events[0]) })).status).toBe(400);
  for (let index = 0; index < 35; index++) await post(report(`browser-${index}`));
  await post({ ...report('browser-34'), sequence: 1, events: [] });
  const data = await (await fetch(endpoint)).json();
  expect(data.clients).toHaveLength(32);
  expect(data.clients[0].clientId).toBe('browser-3');
  expect(data.clients.at(-1).events).toHaveLength(2);
}));


test('CLI reads the same agent report without attaching a sandbox client', () => withServer(async url => {
  let output = '';
  const code = await runServeDiagnostics(parseArgs(['serve', 'diagnostics', '--url', url, '--json']), {
    stdout: { write: value => { output += value; } },
  });
  expect(code).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ version: 1, server: { http: 'responding', mode: 'hosted' }, clients: [] });
}));
