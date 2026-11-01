import assert from 'node:assert/strict';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { HOSTED_METHOD_BODY_LIMIT } from '../../../src/serve/hosted/method-protocol.js';

// The host compares project directories by their real path.
const directory = realpathSync(process.argv[2]);
const mount = createBridgeMount({ hosted: true, projectKey: directory, disableAuditLog: true });
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  void mount.handler(request, response, url).then(handled => {
    if (!handled) response.writeHead(404).end();
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address === 'object');
const base = `http://127.0.0.1:${address.port}`;
const payload = { rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory, sessionToken: 'session-token' };

try {
  await mount.startHostedSandbox(payload, base);
  const oversized = JSON.stringify({ instanceId: mount.instanceId, projectDir: directory, padding: 'x'.repeat(HOSTED_METHOD_BODY_LIMIT) });
  // The method route and the repro route read their body the same way, and
  // both answer an oversized one before reading it to its end (#1710).
  for (const path of ['/__pyric/hosted/method', '/__pyric/hosted/repro']) {
    const refused = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: oversized });
    assert.equal(refused.status, 413, path);
    assert.equal(refused.headers.get('connection'), 'close', path);
    await refused.arrayBuffer();
    const next = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(next.status, 405, path);
  }
} finally {
  await mount.close();
  server.close();
}

console.log('Hosted method body limit passed');
