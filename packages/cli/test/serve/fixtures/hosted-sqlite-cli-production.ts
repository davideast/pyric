import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { parseArgs } from '../../../src/cli/parse-args.js';
import { runSurfaceMethod } from '../../../src/cli/surface-method-runner.js';

const directory = process.argv[2];
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
  bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: directory };

async function run(flags: string[], env: NodeJS.ProcessEnv = {}) {
  let output = '';
  const code = await runSurfaceMethod('storage.status', parseArgs(['storage', 'status', '--json', ...flags]), {
    cwd: directory,
    env,
    stdout: { write: text => { output += text; } },
    stderr: { write: () => {} },
    discover: async () => ({ url: base, base, mcpUrl: `${base}/__pyric/mcp`,
      instanceId: mount.instanceId, source: 'pointer .pyric/serve.json' }),
  });
  assert.equal(code, 2);
  return JSON.parse(output);
}

try {
  await mount.startHostedSandbox(payload, base);
  const disabled = await run([]);
  assert.equal(disabled.data.code, 'production_disabled');

  // Never confirm a production operation: reaching the confirmation gate proves
  // the flag survived CLI parsing, HTTP validation, and hosted method dispatch.
  const enabled = await run(['--allow-production']);
  assert.equal(enabled.data.code, 'invalid_arguments');
  assert.equal(enabled.data.field, 'confirm');

  const fromEnvironment = await run([], { PYRIC_ALLOW_PRODUCTION: '1' });
  assert.equal(fromEnvironment.data.field, 'confirm');
  const disabledAgain = await run([]);
  assert.equal(disabledAgain.data.code, 'production_disabled', 'permission is scoped to the call');
} finally {
  await mount.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
console.log('Hosted CLI production flag passed');
