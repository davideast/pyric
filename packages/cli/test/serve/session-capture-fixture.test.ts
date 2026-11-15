import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { applyFullState, captureFullState, initializeSandbox } from 'pyric/sandbox';
import { captureSandboxSnapshot, restoreSandboxSnapshot } from 'pyric/sandbox/internal';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { getDatabase, sandbox as rtdbSandbox } from 'pyric/database';
import { getStorageSandbox } from 'pyric/storage';
import {
  deployStorageBucketRules,
  lockUndeployedStorageBuckets,
  replaceStorageRules,
} from 'pyric/storage/internal';

import { buildLiveSessionCaptureFixture } from '../../src/serve/session-capture-fixture.js';

const INITIAL_STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /{allPaths=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

const UPDATED_STORAGE_RULES = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /files/{name} { allow read, write: if request.auth != null; }',
  '  }',
  '}',
].join('\n');

const INITIAL_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

const UPDATED_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /items/{id} { allow read, write: if request.auth != null; }',
  '  }',
  '}',
].join('\n');

describe('buildLiveSessionCaptureFixture', () => {
  it('omits Firestore and RTDB on a Storage-only sandbox, then captures runtime installs and removals', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    getStorageSandbox(sandbox, { rules: INITIAL_STORAGE_RULES });
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    lockUndeployedStorageBuckets(sandbox, 'allow');

    const initial = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      authState: { users: [], currentUser: null },
    });
    expect(initial.services.firestore).toBeUndefined();
    expect(initial.services.rtdb).toBeUndefined();
    expect(initial.services.storage?.rules.source).toBe(INITIAL_STORAGE_RULES);

    // Installing rules at runtime on services that booted without rules must be captured.
    setFirestoreRules(sandbox, UPDATED_FIRESTORE_RULES);
    rtdbSandbox.setRules(db, { rules: { items: { '.read': true, '.write': true } } });
    await replaceStorageRules(sandbox, UPDATED_STORAGE_RULES, {});

    const updated = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      authState: { users: [], currentUser: null },
      capturedBy: 'instance-1',
    });
    expect(updated.capturedBy).toBe('instance-1');
    expect(updated.services.firestore?.rules.source).toBe(UPDATED_FIRESTORE_RULES);
    expect(updated.services.rtdb?.rules.json).toEqual({
      rules: { items: { '.read': true, '.write': true } },
    });
    expect(updated.services.storage?.rules.source).toBe(UPDATED_STORAGE_RULES);

    rtdbSandbox.setRules(db, null);
    await replaceStorageRules(sandbox, null, {});

    const removed = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      authState: { users: [], currentUser: null },
    });
    expect(removed.services.firestore?.rules.source).toBe(UPDATED_FIRESTORE_RULES);
    expect(removed.services.rtdb).toBeUndefined();
    expect(removed.services.storage).toBeUndefined();
  });

  it('omits Firestore and Storage on an RTDB-only sandbox, including permissive policy', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    lockUndeployedStorageBuckets(sandbox, 'allow');
    rtdbSandbox.setRules(db, { rules: { nodes: { '.read': true, '.write': false } } });

    const fixture = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      authState: { users: [], currentUser: null },
    });
    expect(fixture.services.firestore).toBeUndefined();
    expect(fixture.services.storage).toBeUndefined();
    expect(fixture.services.rtdb?.rules.json).toEqual({
      rules: { nodes: { '.read': true, '.write': false } },
    });
  });

  it('omits RTDB and Storage on a Firestore-only sandbox, including permissive policy', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    setFirestoreRules(sandbox, INITIAL_FIRESTORE_RULES);
    rtdbSandbox.setDefaultPolicy(db, 'allow');
    lockUndeployedStorageBuckets(sandbox, 'allow');

    const fixture = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      authState: { users: [], currentUser: null },
    });
    expect(fixture.services.firestore?.rules.source).toBe(INITIAL_FIRESTORE_RULES);
    expect(fixture.services.rtdb).toBeUndefined();
    expect(fixture.services.storage).toBeUndefined();

    // Updating boot Firestore rules captures the live replacement.
    setFirestoreRules(sandbox, UPDATED_FIRESTORE_RULES);
    const updated = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      authState: { users: [], currentUser: null },
    });
    expect(updated.services.firestore?.rules.source).toBe(UPDATED_FIRESTORE_RULES);
    expect(updated.services.rtdb).toBeUndefined();
    expect(updated.services.storage).toBeUndefined();
  });

  it('captures per-bucket default Storage rules updates without leaking Firestore', () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    deployStorageBucketRules(sandbox, 'demo.appspot.com', INITIAL_STORAGE_RULES);
    deployStorageBucketRules(sandbox, 'media-bucket', UPDATED_STORAGE_RULES);

    const initial = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      defaultStorageBucket: 'demo.appspot.com',
      authState: { users: [], currentUser: null },
    });
    expect(initial.services.firestore).toBeUndefined();
    expect(initial.services.rtdb).toBeUndefined();
    expect(initial.services.storage?.rules.source).toBe(INITIAL_STORAGE_RULES);

    deployStorageBucketRules(sandbox, 'demo.appspot.com', UPDATED_STORAGE_RULES);
    const updated = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      defaultStorageBucket: 'demo.appspot.com',
      authState: { users: [], currentUser: null },
    });
    expect(updated.services.firestore).toBeUndefined();
    expect(updated.services.storage?.rules.source).toBe(UPDATED_STORAGE_RULES);
  });

  it('keeps Firestore omitted after checkpoint, snapshot(), and captureSandboxSnapshot round-trips', async () => {
    const source = initializeSandbox();
    const sourceDb = getDatabase(source);
    rtdbSandbox.setRules(sourceDb, { rules: { items: { '.read': true, '.write': false } } });
    getStorageSandbox(source, { rules: INITIAL_STORAGE_RULES });

    // 1. Full-state checkpoint round-trip
    const checkpointTarget = initializeSandbox();
    await applyFullState(checkpointTarget, await captureFullState(source));
    const afterCheckpoint = buildLiveSessionCaptureFixture({
      sandbox: checkpointTarget,
      authState: { users: [], currentUser: null },
    });
    expect(afterCheckpoint.services.firestore).toBeUndefined();
    expect(afterCheckpoint.services.storage?.rules.source).toBe(INITIAL_STORAGE_RULES);
    expect(afterCheckpoint.services.rtdb?.rules.json).toEqual({
      rules: { items: { '.read': true, '.write': false } },
    });

    // 2. Sandbox snapshot() / loadSnapshot() round-trip
    const persistTarget = initializeSandbox();
    persistTarget.loadSnapshot(source.snapshot());
    const afterLoadSnapshot = buildLiveSessionCaptureFixture({
      sandbox: persistTarget,
      authState: { users: [], currentUser: null },
    });
    expect(afterLoadSnapshot.services.firestore).toBeUndefined();

    // 3. captureSandboxSnapshot() / restoreSandboxSnapshot() round-trip
    const codecTarget = initializeSandbox();
    const { refusals } = await restoreSandboxSnapshot(
      codecTarget,
      await captureSandboxSnapshot(source),
      { merge: false },
    );
    expect(refusals).toEqual([]);
    const afterCodecRestore = buildLiveSessionCaptureFixture({
      sandbox: codecTarget,
      authState: { users: [], currentUser: null },
    });
    expect(afterCodecRestore.services.firestore).toBeUndefined();
    expect(afterCodecRestore.services.storage?.rules.source).toBe(INITIAL_STORAGE_RULES);
  });
});
