import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIndexConfigStore } from '../../src/serve/index-config-store.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { startStaticServer, silentServeLogger } from '../../src/serve/server.js';
import { createIndexConfigClient } from '../../src/serve/runtime/index-config-client.js';

async function fixture(run: (root: string, serverUrl: string, token: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'pyric-index-route-'));
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public/index.html'), '<html></html>');
  const namespace = createPyricNamespace({
    sdkDir: root,
    indexes: createIndexConfigStore(root),
    initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
  });
  const server = await startStaticServer({
    publicDir: join(root, 'public'),
    port: 0,
    host: '127.0.0.1',
    namespaceHandler: namespace,
    logger: silentServeLogger(),
  });
  try {
    const init = await (await fetch(server.url + '/__pyric/init.json')).json();
    await run(root, server.url, init.sessionToken);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test('GET /__pyric/indexes returns 200 and resolves RTDB indexes when firebase.json does not configure firestore (#696)', () => fixture(async (root, serverUrl, token) => {
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
  await writeFile(join(root, 'database.rules.json'), JSON.stringify({ rules: { projects: { '.indexOn': 'budget' } } }));

  // 1. Without service parameter: auto-resolves to RTDB
  const defaultRes = await fetch(`${serverUrl}/__pyric/indexes`, {
    headers: { 'x-pyric-session-token': token },
  });
  expect(defaultRes.status).toBe(200);
  const defaultBody = await defaultRes.json();
  expect(defaultBody.status).toBe('configured');
  expect(defaultBody.service).toBe('rtdb');
  expect(defaultBody.path).toBe('database.rules.json');

  // 2. With ?service=firestore: returns 200 with status: 'unconfigured' instead of 400
  const firestoreRes = await fetch(`${serverUrl}/__pyric/indexes?service=firestore`, {
    headers: { 'x-pyric-session-token': token },
  });
  expect(firestoreRes.status).toBe(200);
  const firestoreBody = await firestoreRes.json();
  expect(firestoreBody.status).toBe('unconfigured');
  expect(firestoreBody.service).toBe('firestore');
  expect(firestoreBody.config).toBeNull();

  // 3. With ?service=rtdb: returns 200 with RTDB config
  const rtdbRes = await fetch(`${serverUrl}/__pyric/indexes?service=rtdb`, {
    headers: { 'x-pyric-session-token': token },
  });
  expect(rtdbRes.status).toBe(200);
  const rtdbBody = await rtdbRes.json();
  expect(rtdbBody.status).toBe('configured');
  expect(rtdbBody.service).toBe('rtdb');

  // 4. Client handles both cleanly
  const fetcher = ((path: string, options?: RequestInit) => fetch(serverUrl + path, options)) as typeof fetch;
  const client = createIndexConfigClient(fetcher);
  expect(await client.read('firestore')).toBeNull();
  const rtdbClientConfig = await client.read('rtdb');
  expect(rtdbClientConfig).not.toBeNull();
  expect(rtdbClientConfig?.path).toBe('database.rules.json');
  expect((await client.read())?.service).toBe('rtdb');
}));

test('GET /__pyric/indexes returns 200 unconfigured when neither firestore nor database is configured', () => fixture(async (root, serverUrl, token) => {
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ storage: { rules: 'storage.rules' } }));

  const defaultRes = await fetch(`${serverUrl}/__pyric/indexes`, {
    headers: { 'x-pyric-session-token': token },
  });
  expect(defaultRes.status).toBe(200);
  expect((await defaultRes.json()).status).toBe('unconfigured');

  const firestoreRes = await fetch(`${serverUrl}/__pyric/indexes?service=firestore`, {
    headers: { 'x-pyric-session-token': token },
  });
  expect(firestoreRes.status).toBe(200);
  expect((await firestoreRes.json()).status).toBe('unconfigured');

  const rtdbRes = await fetch(`${serverUrl}/__pyric/indexes?service=rtdb`, {
    headers: { 'x-pyric-session-token': token },
  });
  expect(rtdbRes.status).toBe(200);
  expect((await rtdbRes.json()).status).toBe('unconfigured');
}));

test('POST /__pyric/indexes returns 400 when previewing an unconfigured service', () => fixture(async (root, serverUrl, token) => {
  await writeFile(join(root, 'firebase.json'), JSON.stringify({ database: { rules: 'database.rules.json' } }));
  await writeFile(join(root, 'database.rules.json'), JSON.stringify({ rules: {} }));

  const query = {
    collectionGroup: 'projects',
    queryScope: 'COLLECTION',
    filters: [{ field: 'status', op: '==' }],
    orders: [{ field: 'budget', direction: 'desc' }],
  };

  const previewRes = await fetch(`${serverUrl}/__pyric/indexes`, {
    method: 'POST',
    headers: { 'x-pyric-session-token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  expect(previewRes.status).toBe(400);
  const body = await previewRes.json();
  expect(body.error).toContain('Set firestore.indexes in firebase.json');
}));
