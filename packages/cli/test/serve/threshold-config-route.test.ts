import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThresholdConfigStore } from '../../src/serve/threshold-config-store.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { startStaticServer, silentServeLogger } from '../../src/serve/server.js';
import { createThresholdConfigClient } from '../../src/serve/runtime/threshold-config-client.js';

test('project threshold client round-trips through the guarded namespace; other origins and missing tokens cannot write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pyric-threshold-route-'));
  await mkdir(join(root, 'public')); await writeFile(join(root, 'public/index.html'), '<html></html>');
  const namespace = createPyricNamespace({ sdkDir: root, thresholds: createThresholdConfigStore(root), initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }) });
  const server = await startStaticServer({ publicDir: join(root, 'public'), port: 0, host: '127.0.0.1', namespaceHandler: namespace, logger: silentServeLogger() });
  try {
    const init = await (await fetch(server.url + '/__pyric/init.json')).json();
    expect(init.thresholds).toBe(true);
    const endpoint = server.url + '/__pyric/thresholds';
    expect((await fetch(endpoint)).status).toBe(401);
    expect((await fetch(endpoint, { method: 'PUT', headers: { origin: 'https://example.com', 'x-pyric-session-token': init.sessionToken, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    const fetcher = ((path: string, options?: RequestInit) => fetch(server.url + path, options)) as typeof fetch;
    const client = createThresholdConfigClient(fetcher);
    const current = (await client.read())!;
    expect(current.config).toEqual({});
    await client.save({ sustainedSeconds: 3, firestore: { documentReads: 30 }, rtdb: { deliveries: null } }, current.revision);
    expect((await createThresholdConfigClient(fetcher).read())!.config).toEqual({ sustainedSeconds: 3, firestore: { documentReads: 30 }, rtdb: { deliveries: null } });
    await expect(client.save({}, current.revision)).rejects.toThrow('changed');
  } finally { await server.stop(); await rm(root, { recursive: true, force: true }); }
});
