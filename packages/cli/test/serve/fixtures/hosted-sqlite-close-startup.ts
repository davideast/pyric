import assert from 'node:assert/strict';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';

const project = process.argv[2];
const payload = { rules: null, rulesHash: null, bridgeUrl: null, seed: null,
  capture: false, hosted: true, projectKey: project };
const mount = createBridgeMount({ hosted: true, projectKey: project, disableAuditLog: true });
try {
  const starting = mount.startHostedSandbox(payload, 'http://127.0.0.1:1');
  // Attach the rejection handler before shutdown can settle the start promise.
  const rejected = assert.rejects(starting, { message: 'The hosted sandbox closed during startup.' });
  await mount.close();
  await rejected;
  assert.equal(mount.sandboxConnected(), false);
  // A completed close must also release the runtime's persistence connection.
  const replacement = createBridgeMount({ hosted: true, projectKey: project, disableAuditLog: true });
  try {
    await replacement.startHostedSandbox(payload, 'http://127.0.0.1:1');
    assert.equal(replacement.sandboxConnected(), true);
  } finally { await replacement.close(); }
} finally { await mount.close(); }
console.log('Closed startup rejected');
