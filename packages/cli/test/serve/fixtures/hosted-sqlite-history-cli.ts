import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { claimProjectState } from '../../../src/serve/hosted/project-ownership.js';
import { createPyricNamespace } from '../../../src/serve/namespace.js';
const project = process.argv[2];
const owner = await claimProjectState(project);
const persistence = await createHostedPersistence(project);
const cli = fileURLToPath(new URL('../../../src/cli/index.js', import.meta.url));
const execute = promisify(execFile);
const handler = createPyricNamespace({ sdkDir: project, history: persistence.history, sessionToken: 'test-capability',
  boundHost: '127.0.0.1', initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null, hosted: true, projectKey: project }) });
const server = createServer((request, response) => {
  void Promise.resolve(handler(request, response, new URL(request.url ?? '/', 'http://localhost'))).then(handled => {
    const missingRoute = !handled;
    if (missingRoute)
      response.writeHead(404).end();
  });
});
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const origin = `http://127.0.0.1:${address.port}`;
  persistence.history.observe({ kind: 'operation', id: 'one', at: 1, service: 'auth' });
  assert.equal((await fetch(`${origin}/__pyric/history`)).status, 401);
  assert.equal((await fetch(`${origin}/__pyric/history`, { headers: { 'x-pyric-session-token': 'wrong' } })).status, 401);
  const args = ['sandbox', 'history'];
  const run = async (...rest: string[]) => execute(process.execPath, [cli, ...args, ...rest], { cwd: project, timeout: 10000 });
  const status = JSON.parse((await run('status', '--port', String(address.port))).stdout);
  assert.equal(status.healthy, true);
  const archive = join(project, 'backup');
  const exported = JSON.parse((await run('export', '--port', String(address.port), '--out', archive)).stdout);
  assert.equal(exported.sequence, 2);
  const page = JSON.parse((await run('list', '--port', String(address.port), '--service', 'auth', '--limit', '1')).stdout);
  assert.equal(page.records[0].payload.id, 'one');
  const verified = JSON.parse((await run('verify', '--out', archive)).stdout);
  assert.equal(verified.records, 2);
  await assert.rejects(run('status'), /already owns/);
  const neighbor = join(project, 'neighbor');
  mkdirSync(neighbor);
  await assert.rejects(execute(process.execPath, [cli, ...args, 'status', '--port', String(address.port)], { cwd: neighbor, timeout: 10000 }), /different project/);
}
finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  persistence.close();
  owner.close();
}
const offline = await execute(process.execPath, [cli, 'sandbox', 'history', 'list', '--limit', '1'], { cwd: project, timeout: 10000 });
assert.equal(JSON.parse(offline.stdout).records.length, 1);
console.log('History CLI passed');
