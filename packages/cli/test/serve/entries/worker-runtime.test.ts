import { expect, test } from 'bun:test';
import { build } from 'esbuild';
import { runtimeRealm } from './worker-runtime-realm.js';

const entry = new URL('../../../src/serve/entries/worker-runtime.ts', import.meta.url).pathname;

test('the worker runtime bundles for realms without top-level await support', async () => {
  const result = await build({
    entryPoints: [entry], bundle: true, platform: 'browser', format: 'esm',
    target: 'es2020', write: false, logLevel: 'silent',
  });
  expect(result.outputFiles[0]?.text.length).toBeGreaterThan(0);
});

test('a Service Worker can evaluate the entry before init resolves and lazily select hosted mode', async () => {
  const realm = await runtimeRealm({ serviceWorker: true });
  try {
    expect(realm.connections).toEqual([]);
    expect(realm.runtime.useWorker).toBe(true);
    const db = realm.runtime.openWorkerDb('app');
    expect(realm.connections).toEqual([]);
    realm.respond({ hosted: true, bridgeUrl: 'ws://localhost:1234/__pyric/sandbox', projectKey: 'orbit' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(realm.runtime.useHosted).toBe(true);
    expect(realm.runtime.useWorker).toBe(true);
    expect(realm.status().mode).toBe('hosted');
    db.port.close();
    expect(realm.connections).toEqual(['wss://app.example/__pyric/sandbox']);
  } finally { realm.dispose(); }
});

for (const scenario of [
  { name: 'SharedWorker page', options: { sharedWorker: true }, mode: 'shared-worker', useWorker: true, connections: ['shared-worker', 'shared-worker'] },
  { name: 'unsupported page', options: {}, mode: 'in-page', useWorker: false, connections: [] },
  { name: 'forced in-page', options: { sharedWorker: true, forceInPage: true }, mode: 'in-page', useWorker: false, connections: [] },
  { name: 'blocked SharedWorker', options: { sharedWorker: true, blockedWorker: true }, mode: 'in-page', useWorker: false, connections: [] },
  { name: 'Service Worker relay', options: { serviceWorker: true }, mode: 'shared-worker', useWorker: true, connections: ['service-worker-relay'] },
]) {
  test(`runtime selects ${scenario.name}`, async () => {
    const realm = await runtimeRealm(scenario.options);
    try {
      realm.respond({ hosted: false });
      const db = scenario.useWorker ? realm.runtime.openWorkerDb('app') : undefined;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(realm.runtime.useHosted).toBe(false);
      expect(realm.runtime.useWorker).toBe(scenario.useWorker);
      expect(realm.status().mode).toBe(scenario.mode);
      if (db) db.port.close();
      else expect(() => realm.runtime.openWorkerDb('app')).toThrow('No Pyric worker transport');
      expect(realm.connections).toEqual(scenario.connections);
    } finally { realm.dispose(); }
  });
}

test('auth observers use the selected worker backend', async () => {
  const realm = await runtimeRealm({ sharedWorker: true });
  try {
    realm.respond({ hosted: false });
    const messageOffset = realm.messages.length;
    const release = realm.registerAuth();
    const subscriptions = realm.messages.slice(messageOffset).filter(message => message.t === 'sub');
    // The internal current-user mirror follows token changes; the chip observes sign-ins.
    expect(subscriptions.map(message => message.target)).toEqual(['idToken', 'authState']);
    release();
    expect(realm.messages.at(-1)).toMatchObject({ t: 'unsub' });
  } finally { realm.dispose(); }
});

test('hosted pages select the socket synchronously even when SharedWorker is available', async () => {
  const realm = await runtimeRealm({ sharedWorker: true, hosted: true });
  try {
    expect(realm.runtime.useHosted).toBe(true);
    expect(realm.runtime.useWorker).toBe(true);
    expect(realm.status().mode).toBe('hosted');
    realm.runtime.openWorkerDb('app').port.close();
    expect(realm.connections).toEqual(['wss://app.example/__pyric/sandbox', 'wss://app.example/__pyric/sandbox']);
  } finally {
    realm.respond({ hosted: true });
    realm.dispose();
  }
});


test('closing a Service Worker client before init resolves does not open a transport', async () => {
  const realm = await runtimeRealm({ serviceWorker: true });
  try {
    const db = realm.runtime.openWorkerDb('app');
    db.port.close();
    realm.respond({ hosted: true, bridgeUrl: '/__pyric/sandbox', projectKey: 'orbit' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(realm.connections).toEqual([]);
  } finally { realm.dispose(); }
});
