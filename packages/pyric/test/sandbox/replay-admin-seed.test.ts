/**
 * Replay reproduces documents seeded through `sandbox.admin` (#1058 follow-up
 * to PR #1074, FS-MET-2 case 3).
 *
 * Evidence: `SandboxAdmin.setDocument`'s own contract (types/service.ts)
 * says an admin write "leaves a trace in the event log", but before this fix
 * `sandbox.admin.setDocument` / `deleteDocument` went straight to the store
 * and recorded nothing. A session that seeded through them and then wrote
 * could not be replayed: the seed was missing from `history()`, so the
 * dependent user write replayed onto an empty document and diverged.
 *
 * The fix records them the way `getAdminFirestore` writes are already
 * recorded: `request` + `write` events marked `detail.admin`, which replay
 * applies without asking the candidate rules and verify treats as context.
 * The restore paths that stay quiet are pinned in
 * `admin-restore-quiet.test.ts`.
 *
 * Imports go through the package (dist), like replay-fidelity.test.ts: the
 * modular Firestore surface resolves `pyric/sandbox/internal` there.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox, replay, type LocalSandbox, type WriteSandboxEvent } from 'pyric/sandbox';
import { setRules, snapshotDocuments } from 'pyric/sandbox/firestore';
import { doc, getFirestore, setDoc } from 'pyric/firestore';

const DENY_ALL = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`;

function writesOf(sandbox: LocalSandbox): WriteSandboxEvent[] {
  return sandbox.history().filter((e): e is WriteSandboxEvent => e.kind === 'write');
}

function realDivergences(sandbox: LocalSandbox, rules: string) {
  const result = replay(sandbox.history(), rules, {}, snapshotDocuments(sandbox));
  return { result, real: result.divergences.filter((d) => d.kind === 'real-divergence') };
}

describe('replay reproduces documents seeded through sandbox.admin', () => {
  it('FS-MET-2 case 3: an admin seed then a merge write replays with no real divergence', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /profiles/{id} {
      allow create, update: if request.resource.data.keys().hasOnly(['allowed'])
        || (request.resource.data.nested.keep == 1 && request.resource.data.nested.change == 2);
    }
  }
}`;
    const sb = initializeSandbox();
    setRules(sb, rules);
    const db = getFirestore(sb.withAuth({ uid: 'alice' }));
    sb.admin.setDocument('profiles/u1', { nested: { keep: 1, change: 1 } });
    await setDoc(doc(db, 'profiles/u1'), { nested: { change: 2 } }, { merge: true });
    await setDoc(doc(db, 'profiles/u2'), { allowed: true, ignoredSecret: 'drop-me' }, { mergeFields: ['allowed'] });

    const { result, real } = realDivergences(sb, rules);
    expect(real).toEqual([]);
    expect(snapshotDocuments(result.sandbox)).toEqual(snapshotDocuments(sb));
  });

  it('records admin.setDocument as a rules-bypassing write event', () => {
    const sb = initializeSandbox();
    sb.admin.setDocument('seed/a', { v: 1 });
    sb.admin.setDocument('seed/a', { v: 2 });

    const writes = writesOf(sb);
    expect(writes.map((w) => [w.method, w.path, w.priorState, w.nextState])).toEqual([
      ['set', 'seed/a', null, { v: 1 }],
      ['set', 'seed/a', { v: 1 }, { v: 2 }],
    ]);
    for (const write of writes) {
      expect(write.detail?.admin).toBe(true);
      expect(write.auth).toBeNull();
    }
  });

  it('records admin.deleteDocument of an existing document, and nothing for a missing one', () => {
    const sb = initializeSandbox();
    sb.admin.setDocument('seed/a', { v: 1 });

    expect(sb.admin.deleteDocument('seed/a')).toEqual({ deleted: true });
    expect(sb.admin.deleteDocument('seed/missing')).toEqual({ deleted: false });

    const writes = writesOf(sb);
    expect(writes.map((w) => [w.method, w.path, w.detail?.admin])).toEqual([
      ['set', 'seed/a', true],
      ['delete', 'seed/a', true],
    ]);
    expect(sb.admin.getDocument('seed/a')).toBeNull();
  });

  it('applies admin seeds and deletes on replay without evaluating the candidate rules', () => {
    const sb = initializeSandbox();
    setRules(sb, DENY_ALL);
    sb.admin.setDocument('seed/keep', { v: 1 });
    sb.admin.setDocument('seed/gone', { v: 2 });
    sb.admin.deleteDocument('seed/gone');

    const { result, real } = realDivergences(sb, DENY_ALL);
    expect(real).toEqual([]);
    expect(result.divergences).toEqual([]);
    expect(snapshotDocuments(result.sandbox)).toEqual({ 'seed/keep': { v: 1 } });
  });

  it('replays a session recorded without admin markers as before: rules still decide', () => {
    // An older recording carries no `detail` on its writes. Replay must keep
    // evaluating those writes against the rules, so a write the candidate
    // rules deny still shows up as a divergence.
    const sb = initializeSandbox();
    sb.admin.setDocument('seed/a', { v: 1 });
    const legacy = sb.history().map((event) => {
      if (event.kind !== 'write' && event.kind !== 'request') return event;
      const { detail: _detail, ...rest } = event as WriteSandboxEvent;
      return rest;
    }) as ReturnType<LocalSandbox['history']>;

    const result = replay(legacy, DENY_ALL, {}, snapshotDocuments(sb));
    expect(snapshotDocuments(result.sandbox)).toEqual({});
    expect(result.divergences.filter((d) => d.kind === 'real-divergence').map((d) => d.path)).toEqual(['seed/a']);
  });
});
