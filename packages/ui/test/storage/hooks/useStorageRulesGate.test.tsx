// Real-sandbox probes for `useStorageRulesGate` — same harness family
// as the other storage hook tests: fake-indexeddb backs the sandbox
// in-process, nothing is mocked. Rules deploy the way every
// `packages/pyric/test/storage` rules test deploys them: the FIRST
// `getStorageSandbox` call per sandbox wins the ruleset.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import {
  getStorageSandbox,
  ref,
  uploadBytes,
  deleteObject,
  type FirebaseStorage,
} from 'pyric/storage';
import {
  useStorageRulesGate,
  type UseStorageRulesGateOptions,
} from '../../../src/storage/hooks/useStorageRulesGate.js';
import { renderHook, waitFor } from '../../helpers/render-hook.js';

function uniqueDbName(label: string): string {
  return `pyric-ui-rulesgate-${label}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Owner-only tree: each uid owns `users/<uid>/**`; public read tree. */
const OWNER_RULES = `
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
    match /public/{allPaths=**} {
      allow read: if true;
    }
  }
}`;

type HookProps = {
  storage: FirebaseStorage | null;
  options?: UseStorageRulesGateOptions;
};
const runHook = (p: HookProps) => useStorageRulesGate(p.storage, p.options);

describe('useStorageRulesGate', () => {
  it('reads the deployed ruleset off the sandbox handle and flips verdicts with identity', async () => {
    const sandbox = initializeSandbox({});
    const dbName = uniqueDbName('identity');
    const alice = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName,
      rules: OWNER_RULES,
    });

    const { result } = renderHook(runHook, { storage: alice });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // The ruleset came from the handle — no `rules` option passed.
    expect(result.current.source).toBe('sandbox');
    expect(result.current.advisory).toBe(false);
    expect(result.current.identity).toEqual({ uid: 'alice' });

    // Alice owns her tree…
    const own = result.current.verdictFor('users/alice/notes.txt');
    expect(own).toMatchObject({ read: true, write: true, delete: true, upload: true });
    expect(own.reasons).toEqual({ read: [], write: [] });

    // …and is denied on Bob's, with the evaluator's reason trace.
    const theirs = result.current.verdictFor('users/bob/notes.txt');
    expect(theirs).toMatchObject({ read: false, write: false, delete: false, upload: false });
    expect(theirs.reasons.read.length).toBeGreaterThan(0);
    expect(theirs.reasons.write.length).toBeGreaterThan(0);

    // Same sandbox, different context → flipped verdicts. (Rules were
    // already deployed by the first factory call.)
    const bob = getStorageSandbox(sandbox.withAuth({ uid: 'bob' }), { dbName });
    const { result: bobResult } = renderHook(runHook, { storage: bob });
    await waitFor(() => expect(bobResult.current.status).toBe('ready'));
    expect(bobResult.current.verdictFor('users/bob/notes.txt').write).toBe(true);
    expect(bobResult.current.verdictFor('users/alice/notes.txt').read).toBe(false);
  });

  it('derives delete/upload from write — a read-only tree denies all three', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('readonly'),
      rules: OWNER_RULES,
    });
    const { result } = renderHook(runHook, { storage });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const v = result.current.verdictFor('public/announcement.txt');
    expect(v.read).toBe(true);
    expect(v.write).toBe(false);
    expect(v.delete).toBe(v.write);
    expect(v.upload).toBe(v.write);
  });

  it('verdicts agree with the REAL enforcement layer', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('truth'),
      rules: OWNER_RULES,
    });
    const { result } = renderHook(runHook, { storage });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    // Allowed verdict → the real op succeeds.
    expect(result.current.verdictFor('users/alice/a.txt').write).toBe(true);
    await uploadBytes(ref(storage, 'users/alice/a.txt'), new Blob(['a']));
    expect(result.current.verdictFor('users/alice/a.txt').delete).toBe(true);
    await deleteObject(ref(storage, 'users/alice/a.txt'));

    // Denied verdict → the real op throws the typed error the verdict
    // predicted (the gate is the same evaluator the sandbox enforces
    // with — sandbox verdicts are truthful, not advisory).
    expect(result.current.verdictFor('users/bob/a.txt').write).toBe(false);
    let thrown: unknown;
    try {
      await uploadBytes(ref(storage, 'users/bob/a.txt'), new Blob(['a']));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: unknown }).code).toBe('storage/unauthorized');
  });

  it('identity option overrides the handle identity (advisory what-if)', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('override'),
      rules: OWNER_RULES,
    });

    const { result } = renderHook(runHook, {
      storage,
      options: { identity: { uid: 'bob' } },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.identity).toEqual({ uid: 'bob' });
    expect(result.current.verdictFor('users/bob/x.txt').write).toBe(true);
    expect(result.current.verdictFor('users/alice/x.txt').write).toBe(false);

    // Explicit `null` = anonymous (distinct from "omitted").
    const { result: anon } = renderHook(runHook, {
      storage,
      options: { identity: null },
    });
    await waitFor(() => expect(anon.current.status).toBe('ready'));
    expect(anon.current.verdictFor('users/alice/x.txt').read).toBe(false);
    expect(anon.current.verdictFor('public/x.txt').read).toBe(true);
  });

  it('pre-evaluates the paths option into a verdicts record (normalized keys)', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('paths'),
      rules: OWNER_RULES,
    });
    const { result } = renderHook(runHook, {
      storage,
      options: { paths: ['/users/alice/a.txt/', 'users/bob/b.txt'] },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(Object.keys(result.current.verdicts).sort()).toEqual([
      'users/alice/a.txt',
      'users/bob/b.txt',
    ]);
    expect(result.current.verdicts['users/alice/a.txt'].write).toBe(true);
    expect(result.current.verdicts['users/bob/b.txt'].write).toBe(false);
  });

  it('no rules configured → source "none", everything allows (open-by-default parity)', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox, {
      dbName: uniqueDbName('norules'),
    });
    const { result } = renderHook(runHook, { storage });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.source).toBe('none');
    // Mirrors enforce.ts: no rules → allow. The real op agrees.
    expect(result.current.verdictFor('anywhere/x.txt').write).toBe(true);
    await uploadBytes(ref(storage, 'anywhere/x.txt'), new Blob(['x']));
  });

  it('explicit rules option wins over the sandbox ruleset; malformed source → error (fails open)', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('option'),
      rules: OWNER_RULES,
    });

    // What-if evaluation under a stricter ruleset than the deployed one.
    const { result } = renderHook(runHook, {
      storage,
      options: {
        rules: `
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if true;
    }
  }
}`,
      },
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.source).toBe('option');
    // The deployed ruleset would allow this write — the option ruleset denies.
    expect(result.current.verdictFor('users/alice/a.txt').write).toBe(false);
    expect(result.current.verdictFor('users/alice/a.txt').read).toBe(true);

    const { result: bad } = renderHook(runHook, {
      storage,
      options: { rules: 'service firebase.storage {' },
    });
    await waitFor(() => expect(bad.current.status).toBe('error'));
    expect(bad.current.error).toBeInstanceOf(Error);
    // Fails OPEN — affordances are advisory; enforcement stays real.
    expect(bad.current.verdictFor('users/bob/x.txt').write).toBe(true);
  });

  it('writeResource binds request.resource for the write verdict; omitted = delete semantics', async () => {
    const sandbox = initializeSandbox({});
    const storage = getStorageSandbox(sandbox.withAuth({ uid: 'alice' }), {
      dbName: uniqueDbName('payload'),
      rules: `
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{allPaths=**} {
      allow read: if true;
      allow write: if request.resource == null || request.resource.size < 100;
    }
  }
}`,
    });

    const small = renderHook(runHook, {
      storage,
      options: { writeResource: { size: 50, contentType: 'text/plain' } },
    });
    await waitFor(() => expect(small.result.current.status).toBe('ready'));
    expect(small.result.current.verdictFor('uploads/ok.txt').upload).toBe(true);

    const big = renderHook(runHook, {
      storage,
      options: { writeResource: { size: 200 } },
    });
    await waitFor(() => expect(big.result.current.status).toBe('ready'));
    expect(big.result.current.verdictFor('uploads/big.txt').upload).toBe(false);

    // Omitted writeResource leaves request.resource unset — exactly
    // what a DELETE carries, so the `request.resource == null` arm
    // allows (and a bare `size < N` rule would conservatively deny).
    const del = renderHook(runHook, { storage });
    await waitFor(() => expect(del.result.current.status).toBe('ready'));
    expect(del.result.current.verdictFor('uploads/ok.txt').delete).toBe(true);
  });

  it('is idle (allow-all) when storage is null', () => {
    const { result } = renderHook(runHook, { storage: null });
    expect(result.current.status).toBe('idle');
    expect(result.current.source).toBe('none');
    expect(result.current.verdictFor('anything').read).toBe(true);
  });
});
