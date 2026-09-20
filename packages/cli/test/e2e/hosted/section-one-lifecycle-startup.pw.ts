import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startServe } from '../../../src/cli/serve.js';
import { createBridgeMount } from '../../../src/serve/bridge-mount.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import type { BridgeMessage } from '../../../src/bridge/protocol.js';
import type { InitPayload } from '../../../src/serve/init-payload.js';
import { McpHttpClient } from '../soak/harness.js';

test('closing a mount during startup prevents late sandbox registration', async () => {
  const project = mkdtempSync(join(tmpdir(), 'pyric-mount-startup-'));
  const payload: InitPayload = {
    rules: null, rulesHash: null, storageRules: null, storageRulesHash: null,
    bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: project,
  };
  const mount = createBridgeMount({ hosted: true, projectKey: project, disableAuditLog: true });
  try {
    const starting = mount.startHostedSandbox(payload, 'http://127.0.0.1:1');
    // Attach the rejection assertion before shutdown settles startup.
    const rejected = expect(starting).rejects.toThrow('The hosted sandbox closed during startup.');
    await mount.close();
    await rejected;
    expect(mount.sandboxConnected()).toBe(false);
  } finally {
    await mount.close();
    rmSync(project, { recursive: true, force: true });
  }
});

test('failed hosted initialization leaves no delayed writer after its owner closes', async () => {
  test.setTimeout(15_000);
  const project = mkdtempSync(join(tmpdir(), 'pyric-runtime-init-failure-'));
  const statePath = join(project, '.pyric', 'state', 'hosted', 'state.sqlite');
  const payload: InitPayload = {
    rules: null, rulesHash: null, storageRules: 'not Storage rules', storageRulesHash: null,
    bridgeUrl: null, seed: null, capture: false, hosted: true, projectKey: project,
  };
  const mount = createBridgeMount({ hosted: true, projectKey: project, disableAuditLog: true });
  let replacement: Awaited<ReturnType<typeof createHostedRuntime>> | undefined;
  try {
    await expect(mount.startHostedSandbox(payload, 'http://127.0.0.1:1')).rejects.toThrow('Storage rules parse error');
    await mount.close();
    // The persistence controller normally flushes registered services after 250 ms.
    // A rejected startup must cancel that writer before reporting closed.
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    const preserved = new DatabaseSync(statePath, { readOnly: true });
    try { expect(preserved.prepare('SELECT count(*) AS count FROM records').get()?.count).toBe(0); }
    finally { preserved.close(); }
    const replies: BridgeMessage[] = [];
    replacement = await createHostedRuntime({ ...payload, storageRules: null }, 'http://127.0.0.1:1', message => replies.push(message), project);
    replacement.receive({ type: 'worker-message', clientSessionId: 'corrected', message: {
      t: 'op', id: 'write', method: 'setDoc', path: 'shared/corrected', data: { message: 'Corrected runtime' }, actAs: { mode: 'admin' },
    } });
    await expect.poll(() => replies, { timeout: 5_000 }).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'worker-message-result', message: expect.objectContaining({ t: 'res', id: 'write', ok: true }) }),
    ]));
    await replacement.close();
    expect(existsSync(statePath)).toBe(true);
  } finally {
    await mount.close();
    await replacement?.close();
    rmSync(project, { recursive: true, force: true });
  }
});

for (const { stage, error } of [
  { stage: 'configuration', error: /JSON|parse|property name/i },
  { stage: 'assets', error: /EEXIST|ENOTDIR/ },
  { stage: 'session', error: /failed to read --seed/ },
  { stage: 'bind', error: /EADDRNOTAVAIL/ },
]) {
  test(`failed ${stage} startup releases its project and port for a corrected start`, async () => {
    const project = mkdtempSync(join(tmpdir(), 'pyric-startup-failure-'));
    const cache = join(project, 'bundle-cache');
    const config = join(project, 'firebase.json');
    const seed = join(project, 'seed.json');
    writeFileSync(config, '{}');
    writeFileSync(seed, '{}');
    const blocker = createServer();
    let replacement: Awaited<ReturnType<typeof startServe>> | undefined;
    async function closeBlocker(): Promise<void> {
      const isListening = blocker.listening;
      if (isListening) await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
    try {
      await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve));
      const address = blocker.address();
      const hasNoAddress = address === null || typeof address === 'string';
      if (hasNoAddress) throw new Error('The reserved port has no address.');
      const failsBind = stage === 'bind';
      await closeBlocker();
      const failsConfiguration = stage === 'configuration';
      if (failsConfiguration) writeFileSync(config, '{');
      const failsAssets = stage === 'assets';
      if (failsAssets) writeFileSync(cache, 'A file cannot contain SDK assets.');
      const failsSession = stage === 'session';
      if (failsSession) writeFileSync(seed, '{');
      const options = {
        cwd: project, port: address.port, host: '127.0.0.1', hosted: true,
        noCache: true, cacheRoot: cache, seed, capture: false, watch: false, disableAuditLog: true,
      };
      // TEST-NET-1 is not a local interface; native bind must fail without scanning.
      const host = failsBind ? '192.0.2.1' : '127.0.0.1';
      await expect(startServe({ ...options, host })).rejects.toThrow(error);
      await closeBlocker();
      writeFileSync(config, '{}');
      writeFileSync(seed, '{}');
      if (failsAssets) rmSync(cache);
      replacement = await startServe(options);
      expect(replacement.handle.port).toBe(address.port);
      const mcp = new McpHttpClient(`${replacement.handle.url}/__pyric/mcp`);
      await mcp.initialize();
      await expect(mcp.toolCall('firestore_create_document', {
        path: 'shared/startup', data: { message: 'Corrected startup' }, as: 'admin',
      })).resolves.toMatchObject({ ok: true });
      await expect(mcp.toolCall('firestore_get_document', { path: 'shared/startup', as: 'admin' }))
        .resolves.toMatchObject({ ok: true, data: { exists: true, data: { message: 'Corrected startup' } } });
    } finally {
      await replacement?.handle.stop();
      await closeBlocker();
      rmSync(project, { recursive: true, force: true });
    }
  });
}
