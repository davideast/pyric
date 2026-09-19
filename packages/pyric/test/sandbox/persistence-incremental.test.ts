import { afterEach, expect, test } from 'bun:test';
import { initializeSandbox as initializePackagedSandbox } from 'pyric/sandbox';
import { createMemoryBackend, initializeSandbox, type Sandbox, type PersistenceBackend } from '../../src/sandbox/index.js';
import { doc, getFirestore, runTransaction, writeBatch } from '../../src/firestore/index.js';
import { Bytes } from '../../src/rules/simulator/wrappers/bytes.js';

const sandboxes: Sandbox[] = [];
function createSandbox() {
  const sandbox = initializeSandbox();
  sandboxes.push(sandbox);
  return sandbox;
}
afterEach(() => { for (const sandbox of sandboxes.splice(0)) sandbox.dispose(); });

test('flushing an edit leaves an unrelated persisted document unencoded', async () => {
  let encodings = 0;
  class CountedBytes extends Bytes {
    override toJSON(): unknown { encodings++; return super.toJSON(); }
  }
  const backend = createMemoryBackend();
  const sandbox = createSandbox();
  await sandbox.enablePersistence({ key: 'incremental', injectedBackend: backend, flushIntervalMs: 60_000 });
  sandbox.admin.setDocument('items/cold', { bytes: new CountedBytes(new Uint8Array([1, 2, 3])) });
  sandbox.admin.setDocument('items/hot', { value: 1 });
  await sandbox.flush();
  encodings = 0;

  sandbox.admin.setDocument('items/hot', { value: 2 });
  await sandbox.flush();
  expect(encodings).toBe(0);

  const reopened = createSandbox();
  await reopened.enablePersistence({ key: 'incremental', injectedBackend: backend });
  expect(reopened.admin.getDocument('items/hot')).toEqual({ value: 2 });
  expect(reopened.admin.getDocument('items/cold')).toEqual({ bytes: new Bytes(new Uint8Array([1, 2, 3])) });
});

test('a subscribed service is snapshotted only when it changes', async () => {
  const backend = createMemoryBackend();
  const sandbox = createSandbox();
  let snapshots = 0;
  let state: unknown = { theme: 'dark' };
  let changed = () => {};
  sandbox.registerPersistableService('preferences', {
    snapshot: () => { snapshots++; return state; },
    restore: () => {},
    subscribe: callback => { changed = callback; return () => { changed = () => {}; }; },
  });
  await sandbox.enablePersistence({ key: 'services', injectedBackend: backend, flushIntervalMs: 60_000 });
  await sandbox.flush();
  snapshots = 0;
  sandbox.admin.setDocument('items/hot', { value: 1 });
  await sandbox.flush();
  expect(snapshots).toBe(0);

  state = { theme: 'light' };
  changed();
  await sandbox.flush();
  expect(snapshots).toBe(1);
  const reopened = createSandbox();
  let restored: unknown;
  reopened.registerPersistableService('preferences', { snapshot: () => restored, restore: value => { restored = value; } });
  await reopened.enablePersistence({ key: 'services', injectedBackend: backend });
  expect(restored).toEqual({ theme: 'light' });
});

test('a write arriving during a commit remains pending for the next flush', async () => {
  const storage = createMemoryBackend();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let holdCommit = false;
  const backend: PersistenceBackend = { ...storage, async applyChanges(key, changed, removed) {
    if (holdCommit) { entered.resolve(); await release.promise; }
    await storage.putRecords(key, changed);
    await storage.deleteRecords(key, removed);
  } };
  const sandbox = createSandbox();
  await sandbox.enablePersistence({ key: 'concurrent', injectedBackend: backend, flushIntervalMs: 60_000 });
  sandbox.admin.setDocument('items/hot', { value: 0 });
  await sandbox.flush();
  holdCommit = true;
  sandbox.admin.setDocument('items/hot', { value: 1 });
  const firstFlush = sandbox.flush();
  await entered.promise;
  sandbox.admin.setDocument('items/hot', { value: 2 });
  release.resolve();
  await firstFlush;
  const firstRead = createSandbox();
  await firstRead.enablePersistence({ key: 'concurrent', injectedBackend: storage });
  expect(firstRead.admin.getDocument('items/hot')).toEqual({ value: 1 });

  await sandbox.flush();
  const secondRead = createSandbox();
  await secondRead.enablePersistence({ key: 'concurrent', injectedBackend: storage });
  expect(secondRead.admin.getDocument('items/hot')).toEqual({ value: 2 });
});

test('a failed commit retains both changed and deleted documents for retry', async () => {
  const storage = createMemoryBackend();
  let failCommit = false;
  const backend: PersistenceBackend = { ...storage, async applyChanges(key, changed, removed) {
    if (failCommit) throw new Error('Disk unavailable');
    await storage.putRecords(key, changed);
    await storage.deleteRecords(key, removed);
  } };
  const sandbox = createSandbox();
  await sandbox.enablePersistence({ key: 'retry', injectedBackend: backend, flushIntervalMs: 60_000 });
  sandbox.admin.setDocument('items/hot', { value: 1 });
  sandbox.admin.setDocument('items/cold', { value: 3 });
  await sandbox.flush();
  sandbox.admin.setDocument('items/hot', { value: 2 });
  sandbox.admin.deleteDocument('items/cold');
  failCommit = true;
  await expect(sandbox.flush()).rejects.toThrow('Disk unavailable');
  const beforeRetry = createSandbox();
  await beforeRetry.enablePersistence({ key: 'retry', injectedBackend: storage });
  expect(beforeRetry.admin.getDocument('items/hot')).toEqual({ value: 1 });
  expect(beforeRetry.admin.getDocument('items/cold')).toEqual({ value: 3 });
  failCommit = false;
  await sandbox.flush();
  const afterRetry = createSandbox();
  await afterRetry.enablePersistence({ key: 'retry', injectedBackend: storage });
  expect(afterRetry.admin.getDocument('items/hot')).toEqual({ value: 2 });
  expect(afterRetry.admin.getDocument('items/cold')).toBeNull();
});

test('reset and import replace persisted state, including silent service restores', async () => {
  const backend = createMemoryBackend();
  const sandbox = createSandbox();
  let state: unknown = { theme: 'dark' };
  sandbox.registerPersistableService('preferences', {
    snapshot: () => state,
    restore: value => { state = value; },
    subscribe: () => () => {},
  });
  await sandbox.enablePersistence({ key: 'replace', injectedBackend: backend, flushIntervalMs: 60_000 });
  sandbox.admin.setDocument('items/old', { value: 'old' });
  await sandbox.flush();
  sandbox.reset();
  await sandbox.flush();
  const afterReset = createSandbox();
  await afterReset.enablePersistence({ key: 'replace', injectedBackend: backend });
  expect(afterReset.admin.getDocument('items/old')).toBeNull();

  sandbox.loadSnapshot({ firestore: { 'items/new': { value: 'new' } }, services: { preferences: { theme: 'light' } } });
  await sandbox.flush();
  const afterImport = createSandbox();
  let restored: unknown;
  afterImport.registerPersistableService('preferences', { snapshot: () => restored, restore: value => { restored = value; } });
  await afterImport.enablePersistence({ key: 'replace', injectedBackend: backend });
  expect(afterImport.admin.getDocument('items/new')).toEqual({ value: 'new' });
  expect(afterImport.admin.getDocument('items/old')).toBeNull();
  expect(restored).toEqual({ theme: 'light' });
});

test('clearing persistence leaves memory intact and the next flush restores all documents', async () => {
  const backend = createMemoryBackend();
  const sandbox = createSandbox();
  await sandbox.enablePersistence({ key: 'clear', injectedBackend: backend, flushIntervalMs: 60_000 });
  sandbox.admin.setDocument('items/hot', { value: 1 });
  sandbox.admin.setDocument('items/cold', { value: 2 });
  await sandbox.flush();
  await sandbox.clearPersistence();
  const empty = createSandbox();
  await empty.enablePersistence({ key: 'clear', injectedBackend: backend });
  expect(empty.admin.getDocument('items/hot')).toBeNull();
  expect(sandbox.admin.getDocument('items/hot')).toEqual({ value: 1 });
  await sandbox.flush();
  const restored = createSandbox();
  await restored.enablePersistence({ key: 'clear', injectedBackend: backend });
  expect(restored.admin.getDocument('items/hot')).toEqual({ value: 1 });
  expect(restored.admin.getDocument('items/cold')).toEqual({ value: 2 });
});

test('SDK batches and transactions persist through the same mutation boundary', async () => {
  const backend = createMemoryBackend();
  // The modular SDK resolves its sandbox foundation through the built public exports.
  const sandbox = initializePackagedSandbox();
  sandboxes.push(sandbox);
  await sandbox.enablePersistence({ key: 'sdk', injectedBackend: backend, flushIntervalMs: 60_000 });
  const db = getFirestore(sandbox);
  const first = doc(db, 'items/first');
  const second = doc(db, 'items/second');
  const batch = writeBatch(db);
  batch.set(first, { value: 1 });
  batch.set(second, { value: 2 });
  await batch.commit();
  await sandbox.flush();

  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(first);
    expect(snapshot.data()).toEqual({ value: 1 });
    transaction.update(first, { value: 3 });
    transaction.delete(second);
  });
  await sandbox.flush();
  const reopened = createSandbox();
  await reopened.enablePersistence({ key: 'sdk', injectedBackend: backend });
  expect(reopened.admin.getDocument('items/first')).toEqual({ value: 3 });
  expect(reopened.admin.getDocument('items/second')).toBeNull();
});
