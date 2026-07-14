/**
 * Slice 9 — End-to-end session-archive flow.
 *
 * Walks the entire intended use case in one test (the "minimum
 * bar" demo per the v1 scope):
 *
 *   1. Two clients (alice + bob) authenticated against the same
 *      sandbox.
 *   2. Anonymous client tries to write — denied.
 *   3. Bob tries to write a non-JSON — denied.
 *   4. Bob tries to write a too-large JSON — denied.
 *   5. Alice writes three real session JSONs.
 *   6. Bob lists the archive — sees all three.
 *   7. Bob downloads one — receives the JSON Alice wrote.
 *   8. Anonymous client tries to read — denied.
 *   9. Alice deletes one — listAll reflects the new state.
 *  10. Updated metadata round-trips, blob content unchanged.
 *
 * Verifies the surface end-to-end with the canonical session-archive
 * ruleset that's also embedded verbatim in the package README.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  uploadString,
  getBlob,
  getMetadata,
  updateMetadata,
  listAll,
  deleteObject,
} from '../../src/storage/index.js';

// Production Firebase pattern: a single `allow write` rule
// covers create, update, and delete. Deletes don't carry a
// `request.resource`, so we OR with `request.resource == null` to
// let them through; the size + content-type constraints only fire
// when there IS a payload (creates / updates).
const SESSION_ARCHIVE_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    // Folder-level read so authed clients can listAll the archive.
    // In Firebase, the read permission governs BOTH download and
    // list, and list is evaluated against the prefix path — so the
    // folder needs its own read rule (ST-B2).
    match /sessions {
      allow read: if request.auth != null;
    }
    match /sessions/{sessionId} {
      allow write: if request.auth != null
                   && (request.resource == null
                       || (request.resource.size < 10 * 1024 * 1024
                           && request.resource.contentType == 'application/json'));
      allow read: if request.auth != null;
    }
  }
}`;

function uniqueDbName(label: string): string {
  return `pyric-storage-test-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

describe('session-archive end-to-end', () => {
  it('walks the full use case with rules enforced', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('e2e');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: SESSION_ARCHIVE_RULES,
    });
    const bob = getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), { dbName });
    const anon = getStorageSandbox(sandbox.withAuth(null), { dbName });

    const sessionId = 'gen-1234-abc';
    const path = `sessions/${sessionId}`;

    // 2. Anonymous write is denied.
    await expect(
      uploadBytes(
        ref(anon, path),
        new Blob(['{"task":"x"}']),
        { contentType: 'application/json' },
      ),
    ).rejects.toThrow(/unauthorized/);

    // 3. Bob writes non-JSON — denied.
    await expect(
      uploadString(
        ref(bob, `sessions/text.txt`),
        'just text',
      ),
    ).rejects.toThrow(/unauthorized/);

    // 4. Bob writes oversized JSON — denied. Generate >10MB of data.
    const bigPayload = new Uint8Array(11 * 1024 * 1024);
    await expect(
      uploadBytes(
        ref(bob, `sessions/big.json`),
        bigPayload,
        { contentType: 'application/json' },
      ),
    ).rejects.toThrow(/unauthorized/);

    // 5. Alice writes three sessions.
    const sessions = [
      { id: 'gen-1', body: '{"task":"first","ok":true}' },
      { id: 'gen-2', body: '{"task":"second","ok":false}' },
      { id: 'gen-3', body: '{"task":"third","ok":true}' },
    ];
    for (const s of sessions) {
      const result = await uploadBytes(
        ref(alice, `sessions/${s.id}`),
        new Blob([s.body]),
        {
          contentType: 'application/json',
          customMetadata: { sessionId: s.id, timestamp: '2026-05-10T00:00:00.000Z' },
        },
      );
      expect(result.metadata.contentType).toBe('application/json');
      expect(result.metadata.customMetadata?.sessionId).toBe(s.id);
    }

    // 6. Bob lists the archive — sees all three.
    const listed = await listAll(ref(bob, 'sessions'));
    expect(listed.items.map((i) => i.name).sort()).toEqual(['gen-1', 'gen-2', 'gen-3']);
    expect(listed.prefixes).toEqual([]);

    // 7. Bob downloads gen-2 and gets Alice's JSON back.
    const blob = await getBlob(ref(bob, 'sessions/gen-2'));
    expect(await blob.text()).toBe('{"task":"second","ok":false}');

    // 8. Anonymous read denied.
    await expect(
      getBlob(ref(anon, 'sessions/gen-1')),
    ).rejects.toThrow(/unauthorized/);

    // 9. Alice deletes gen-3.
    await deleteObject(ref(alice, 'sessions/gen-3'));
    const afterDelete = await listAll(ref(alice, 'sessions'));
    expect(afterDelete.items.map((i) => i.name).sort()).toEqual(['gen-1', 'gen-2']);

    // 10. Update metadata for gen-1, verify blob preserved.
    const md = await updateMetadata(ref(alice, 'sessions/gen-1'), {
      customMetadata: { sessionId: 'gen-1', timestamp: '2026-05-10T00:00:00.000Z', tag: 'reviewed' },
    });
    expect(md.customMetadata?.tag).toBe('reviewed');
    expect(md.metageneration).toBe('2');

    const stillThere = await getBlob(ref(bob, 'sessions/gen-1'));
    expect(await stillThere.text()).toBe('{"task":"first","ok":true}');

    // 11. getMetadata returns the latest record.
    const fetched = await getMetadata(ref(bob, 'sessions/gen-1'));
    expect(fetched.customMetadata?.tag).toBe('reviewed');
  });
});
