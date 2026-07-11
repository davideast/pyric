/**
 * `pyric/firestore` — `terminate` honest teardown-forward.
 *
 * Before this change, `terminate` was not exported from
 * `pyric/firestore` at all — importing it from an app bundled under
 * pyric would fail at import time, crashing before the app ever ran a
 * read or write. Unlike the persistence/network family, this is NOT a
 * pure no-op: on a sandbox handle it genuinely calls `Sandbox.dispose()`,
 * which tears down listener registries on the sandbox's environment.
 */
import { describe, it, expect, mock } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore, doc, setDoc, sandbox as sandboxOps } from '../../src/firestore/index.js';
import { terminate } from '../../src/firestore/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if request.auth != null;
    }
  }
}`;

function setup() {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  sandboxOps.setRules(db, RULES);
  return { sandbox, db };
}

describe('terminate', () => {
  it('resolves without throwing on a sandbox handle', async () => {
    const { db } = setup();
    await expect(terminate(db)).resolves.toBeUndefined();
  });

  it('genuinely tears the sandbox down by calling Sandbox.dispose()', async () => {
    const { sandbox, db } = setup();
    const disposeSpy = mock(sandbox.dispose.bind(sandbox));
    sandbox.dispose = disposeSpy;

    await terminate(db);

    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — calling it twice does not throw', async () => {
    const { db } = setup();
    await terminate(db);
    await expect(terminate(db)).resolves.toBeUndefined();
  });
});
