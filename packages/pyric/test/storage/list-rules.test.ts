/**
 * ST-B2 probe — `listAll` enforces storage rules.
 *
 * Pre-fix `list.ts` skipped `enforceRules` entirely, so a denied tree
 * was still fully enumerable (a silent rules bypass the COMPAT listAll
 * + rules rows never disclosed). Firebase Storage's `read` permission
 * governs both download and list, evaluated against the listed prefix
 * path — so `listAll` of a path the rules deny `read` must throw
 * `storage/unauthorized`.
 *
 * Upstream confirmation: Firebase Storage Security Rules — "the read
 * rule covers both getDownloadURL/getBytes and list"; list is checked
 * against the prefix. (No JS-SDK clone file models server-side rule
 * eval; this mirrors the documented rules semantics + the sandbox's
 * own read-enforcement seam.)
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getStorageSandbox, ref, uploadBytes, listAll } from '../../src/storage/index.js';

function uniqueDbName(label: string): string {
  return `pyric-storage-listrules-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

// Authed clients may list (and read/write) anything; anonymous clients
// may not. `read` covers list per Firebase semantics.
const AUTHED_ONLY = `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

describe('ST-B2 — listAll enforces rules', () => {
  it('denies an anonymous listAll of a tree the rules protect', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('deny');
    // First call wins the ruleset for the sandbox; seed under auth.
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: AUTHED_ONLY,
    });
    await uploadBytes(ref(alice, 'sessions/s1.json'), new Blob(['{}']), {
      contentType: 'application/json',
    });

    const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });
    let code: unknown;
    try {
      await listAll(ref(anon, 'sessions'));
    } catch (e) {
      code = (e as { code?: unknown }).code;
    }
    expect(code).toBe('storage/unauthorized');
  });

  it('allows an authed listAll under the same rules', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('allow');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: AUTHED_ONLY,
    });
    await uploadBytes(ref(alice, 'sessions/s1.json'), new Blob(['{}']), {
      contentType: 'application/json',
    });
    const listed = await listAll(ref(alice, 'sessions'));
    expect(listed.items.map((i) => i.name)).toEqual(['s1.json']);
  });

  it('denies listAll and uploads when no rules are configured (closed-by-default)', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, { dbName: uniqueDbName('norules') });
    await expect(uploadBytes(ref(storage, 'x/a.bin'), new Blob(['a']))).rejects.toThrow(/unauthorized/);
    await expect(listAll(ref(storage, 'x'))).rejects.toThrow(/unauthorized/);
  });
});
