import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FirebaseError } from 'pyric/app';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, getStorageService } from 'pyric/storage/internal';
import { createHostedPersistence } from '../../../src/serve/hosted/persistence.js';
import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { replayRepro } from '../../../src/serve/repro/replay.js';

const root = process.argv[2];

function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const tick = () => {
      const value = predicate();
      if (value !== undefined) {
        resolvePromise(value);
        return;
      }
      if (Date.now() >= deadline) {
        rejectPromise(new Error('Timed out waiting for frame'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

// 1. Direct SQLite storage backend matches InMemoryStorageBackend error codes and messages.
{
  const project = join(root, 'direct-parity');
  const persistence = await createHostedPersistence(project);
  const memorySandbox = createSandboxRoot({ mutations: 100, spans: 100 });
  const memory = (await getStorageService(getAdminStorageSandbox(memorySandbox))).backend;
  try {
    let sqliteMissing: unknown;
    let memoryMissing: unknown;
    try { await persistence.storage.readUpload('missing-upload-id'); } catch (error) { sqliteMissing = error; }
    try { await memory.readUpload!('missing-upload-id'); } catch (error) { memoryMissing = error; }
    assert.ok(sqliteMissing instanceof FirebaseError);
    assert.equal(sqliteMissing.code, 'storage/object-not-found');
    assert.equal(sqliteMissing.code, (memoryMissing as { code?: string }).code);
    assert.equal(sqliteMissing.message, (memoryMissing as Error).message);

    const sqliteUploadId = await persistence.storage.beginUpload('pyric-default', 'docs/hello.txt', 5, 'text/plain');
    const memoryUploadId = await memory.beginUpload!('pyric-default', 'docs/hello.txt', 5, 'text/plain');
    let sqliteIncomplete: unknown;
    let memoryIncomplete: unknown;
    try { await persistence.storage.readUpload(sqliteUploadId); } catch (error) { sqliteIncomplete = error; }
    try { await memory.readUpload!(memoryUploadId); } catch (error) { memoryIncomplete = error; }
    assert.ok(sqliteIncomplete instanceof FirebaseError);
    assert.equal(sqliteIncomplete.code, 'storage/invalid-argument');
    assert.equal(sqliteIncomplete.code, (memoryIncomplete as { code?: string }).code);
    assert.equal(sqliteIncomplete.message, (memoryIncomplete as Error).message);

    let sqliteOverflow: unknown;
    try { await persistence.storage.appendUpload(sqliteUploadId, 0, new Uint8Array(6)); } catch (error) { sqliteOverflow = error; }
    assert.ok(sqliteOverflow instanceof FirebaseError);
    assert.equal(sqliteOverflow.code, 'storage/invalid-argument');
  } finally {
    memorySandbox.dispose();
    persistence.close();
  }
}

// 2. Replaying incomplete and unknown finishUpload frames produces zero node/worker plane differences.
{
  const rawDir = join(root, 'replay-parity');
  mkdirSync(rawDir, { recursive: true });
  const runtimeDir = realpathSync(rawDir);
  const sent: Array<{ type: string; clientSessionId?: string; message?: { id?: string; value?: { uploadId: string } } }> = [];
  const runtime = await createHostedRuntime(
    {
      t: 'init',
      sessionToken: 'test-session-token',
      rules: null,
      databaseRules: null,
      storageRules: "rules_version = '2'; service firebase.storage { match /b/{bucket}/o { match /{allPaths=**} { allow read, write: if true; } } }",
      seed: null,
      permissive: true,
      appOptions: { projectId: 'demo-upload-parity', storageBucket: 'demo-upload-parity.appspot.com' },
    },
    'http://127.0.0.1:4400',
    message => sent.push(message as typeof sent[number]),
    runtimeDir,
  );
  try {
    runtime.receive({
      type: 'worker-message',
      clientSessionId: 'uploader',
      message: { t: 'op', id: 'begin-incomplete', method: 'storage.beginUpload', path: 'docs/incomplete.txt', size: 5 },
    });
    const begun = await waitFor(() => sent.find(m => m.type === 'worker-message-result' && m.message?.id === 'begin-incomplete'));
    const uploadId = begun.message!.value!.uploadId;

    runtime.receive({
      type: 'worker-message',
      clientSessionId: 'uploader',
      message: { t: 'op', id: 'finish-incomplete', method: 'storage.finishUpload', uploadId },
    });
    await waitFor(() => sent.find(m => m.type === 'worker-message-result' && m.message?.id === 'finish-incomplete'));

    runtime.receive({
      type: 'worker-message',
      clientSessionId: 'uploader',
      message: { t: 'op', id: 'finish-unknown', method: 'storage.finishUpload', uploadId: 'unknown-upload-id' },
    });
    await waitFor(() => sent.find(m => m.type === 'worker-message-result' && m.message?.id === 'finish-unknown'));

    const repro = await runtime.captureRepro(runtimeDir);
    const replay = await replayRepro(repro);
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.planeDifferences, []);
  } finally {
    await runtime.close();
  }
}

console.log('Upload error parity passed');
