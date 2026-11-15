import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { getDatabase, sandbox as rtdbSandbox } from 'pyric/database';
import { getStorageSandbox } from 'pyric/storage';
import { replaceStorageRules } from 'pyric/storage/internal';

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

const UPDATED_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /items/{id} { allow read, write: if request.auth != null; }',
  '  }',
  '}',
].join('\n');

describe('buildLiveSessionCaptureFixture', () => {
  it('reads active Firestore, RTDB, and Storage rules and reflects rule updates and removals', async () => {
    const sandbox = initializeSandbox();
    const db = getDatabase(sandbox);
    getStorageSandbox(sandbox, { rules: INITIAL_STORAGE_RULES });

    const initial = buildLiveSessionCaptureFixture({
      sandbox,
      defaultDatabase: db,
      authState: { users: [], currentUser: null },
    });
    expect(initial.services.firestore?.rules.source).toContain('allow read, write: if true;');
    expect(initial.services.rtdb).toBeUndefined();
    expect(initial.services.storage?.rules.source).toBe(INITIAL_STORAGE_RULES);

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
    expect(removed.services.rtdb).toBeUndefined();
    expect(removed.services.storage).toBeUndefined();
  });
});
