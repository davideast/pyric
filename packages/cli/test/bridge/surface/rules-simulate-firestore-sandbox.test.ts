/**
 * `rules.simulate` and `rules.explainDenial` for Firestore read the sandbox
 * documents, the same way the in-page data plane does (FS-CON-3 / FS-MET-1,
 * #1058). Each verdict here is checked against what the data plane decides
 * on the same documents, rules and identity. That agreement is the evidence:
 * before this fix the surface simulated with no documents at all, so a
 * `!exists(bans/...)` guard ALLOWED a request the sandbox denies.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { seedDocuments, setRules } from 'pyric/sandbox/firestore';
import { setRules as setDatabaseRules } from 'pyric/sandbox/database';
import { doc, getDoc, getFirestore, setDoc, updateDoc } from 'pyric/firestore';

import { createSurfaceContext, renderSurface } from '../../../src/bridge/surface/index.js';
import type { OperationResult, SurfaceContext } from '../../../src/bridge/surface/index.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} {
      allow get: if resource.data.owner == request.auth.uid;
      allow list: if request.query.limit <= 10;
      allow create: if !exists(/databases/$(database)/documents/bans/$(request.auth.uid));
      allow update: if resource.data.owner == request.auth.uid
        && request.resource.data.owner == resource.data.owner;
    }
    match /adminDocs/{id} {
      allow get: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
  }
}`;

const DOCS = {
  'posts/p1': { owner: 'alice', title: 'Hello' },
  'users/alice': { role: 'admin' },
  'adminDocs/a1': { secret: 42 },
  'bans/bob': { reason: 'spam' },
};

const surface = renderSurface(undefined);

function seeded(): { ctx: SurfaceContext; sandbox: ReturnType<typeof initializeSandbox> } {
  const sandbox = initializeSandbox();
  setRules(sandbox, RULES);
  seedDocuments(sandbox, DOCS);
  return { ctx: createSurfaceContext(sandbox), sandbox };
}

async function call(ctx: SurfaceContext, method: string, args: Record<string, unknown>): Promise<OperationResult> {
  const tool = surface.tools.find((candidate) => candidate.name === 'rules');
  if (tool === undefined) throw new Error('no rules tool');
  return tool.execute({ method, args: { service: 'firestore', ...args } }, ctx);
}

const allowed = (result: OperationResult) => (result.data as { allowed?: boolean } | undefined)?.allowed;

/** Whether the in-page data plane commits/reads the same request. */
async function dataPlane(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch {
    return false;
  }
}

describe('rules.simulate for firestore agrees with the data plane on sandbox documents', () => {
  const cases: Array<[string, Record<string, unknown>, (db: ReturnType<typeof getFirestore>) => Promise<unknown>]> = [
    ['get reads the stored resource', { operation: 'get', path: 'posts/p1', uid: 'alice' },
      (db) => getDoc(doc(db, 'posts/p1'))],
    ['get() reads a sandbox document', { operation: 'get', path: 'adminDocs/a1', uid: 'alice' },
      (db) => getDoc(doc(db, 'adminDocs/a1'))],
    ['!exists() sees a sandbox document', { operation: 'create', path: 'posts/p2', uid: 'bob', data: { owner: 'bob' } },
      (db) => setDoc(doc(db, 'posts/p2'), { owner: 'bob' })],
    ['update merges the patch into the stored document', { operation: 'update', path: 'posts/p1', uid: 'alice', data: { title: 'New' } },
      (db) => updateDoc(doc(db, 'posts/p1'), { title: 'New' })],
  ];

  for (const [label, args, run] of cases) {
    it(label, async () => {
      const surfaceVerdict = allowed(await call(seeded().ctx, 'simulate', args));
      const explainVerdict = allowed(await call(seeded().ctx, 'explainDenial', args));
      const { sandbox } = seeded();
      const db = getFirestore(sandbox.withAuth({ uid: String(args.uid) }));
      const planeVerdict = await dataPlane(() => run(db));
      expect({ surfaceVerdict, explainVerdict }).toEqual({ surfaceVerdict: planeVerdict, explainVerdict: planeVerdict });
    });
  }

  it('the expected verdicts (guards the agreement above from agreeing on nothing)', async () => {
    const verdicts = await Promise.all(cases.map(([, args]) => call(seeded().ctx, 'simulate', args).then(allowed)));
    expect(verdicts).toEqual([true, true, false, true]);
  });

  it('a draft rules source still reads the sandbox documents', async () => {
    expect(allowed(await call(seeded().ctx, 'simulate', {
      operation: 'create', path: 'posts/p2', uid: 'bob', data: { owner: 'bob' }, rules: RULES,
    }))).toBe(false);
  });
});

describe('rules.simulate for firestore takes a list query', () => {
  it('evaluates request.query on a list', async () => {
    const { ctx } = seeded();
    expect(allowed(await call(ctx, 'simulate', { operation: 'list', path: 'posts', uid: 'alice', query: { limit: 5 } }))).toBe(true);
    expect(allowed(await call(ctx, 'simulate', { operation: 'list', path: 'posts', uid: 'alice', query: { limit: 50 } }))).toBe(false);
  });

  it('refuses a query on a firestore get', async () => {
    const result = await call(seeded().ctx, 'simulate', { operation: 'get', path: 'posts/p1', query: { limit: 5 } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('query');
  });

  it('refuses a database-shaped query on a firestore list', async () => {
    const result = await call(seeded().ctx, 'simulate', { operation: 'list', path: 'posts', query: { orderByKey: true } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('query');
  });

  it('refuses a firestore-shaped query on a database read', async () => {
    const result = await call(seeded().ctx, 'simulate', { service: 'database', operation: 'read', path: 'items', query: { limit: 5 } });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('query');
  });

  it('still takes a database query on a database read', async () => {
    const sandbox = initializeSandbox();
    setDatabaseRules(sandbox, { rules: { items: { '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid" } } });
    const ctx = createSurfaceContext(sandbox);
    const result = await call(ctx, 'simulate', {
      service: 'database', operation: 'read', path: 'items', uid: 'alice', query: { orderByChild: 'owner', equalTo: 'alice', limitToFirst: 5 },
    });
    expect(result.ok).toBe(true);
    expect((result.data as { decision?: string }).decision).toBe('ALLOW');
  });
});

describe('rules.explainDenial for firestore takes a draft and a query', () => {
  it('explains a draft rules source against the sandbox documents', async () => {
    const draft = RULES.replace("allow get: if resource.data.owner == request.auth.uid;", 'allow get: if false;');
    const result = await call(seeded().ctx, 'explainDenial', { operation: 'get', path: 'posts/p1', uid: 'alice', rules: draft });
    expect(result.ok).toBe(true);
    expect(allowed(result)).toBe(false);
    const running = await call(seeded().ctx, 'explainDenial', { operation: 'get', path: 'posts/p1', uid: 'alice' });
    expect(allowed(running)).toBe(true);
  });

  it('explains a list with its query', async () => {
    const result = await call(seeded().ctx, 'explainDenial', { operation: 'list', path: 'posts', uid: 'alice', query: { limit: 50 } });
    expect(result.ok).toBe(true);
    expect(allowed(result)).toBe(false);
  });

  it('still refuses source for firestore', async () => {
    const result = await call(seeded().ctx, 'explainDenial', { operation: 'get', path: 'posts/p1', source: RULES });
    expect(result.ok).toBe(false);
  });
});
