/**
 * Deterministic seeded two-world partial-observation soundness oracle across
 * Firestore (`firestoreVerdict`), RTDB (`rtdbVerdict`), and Storage
 * (`storageVerdict`).
 *
 * Invariant: whenever the full ground-truth world `(state, auth, rules, op)`
 * DENIES an operation in `Sandbox` / `evaluateStorageRules`, projecting any
 * partial observation into `ObservedSessionDataStore` + `ObservedCall` MUST
 * NEVER return `allow` (`0` false-allows permitted; only `deny` or
 * `unevaluated` is sound).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import {
  getAdminDatabase,
  getDatabase,
  ref as dbRef,
  sandbox as dbSandbox,
  set as dbSet,
  update as dbUpdate,
} from 'pyric/database';
import { deleteDoc, doc, getAdminFirestore, getDoc, getFirestore, setDoc, updateDoc } from 'pyric/firestore';
import { initializeSandbox, type ObservedCall } from 'pyric/sandbox';
import { getStorageSandbox } from 'pyric/storage';
import { compiledStorageRulesForBucket, evaluateStorageRules } from 'pyric/storage/internal';
import { createObservedSessionDataStore } from '../../../../src/serve/observed-session/store.js';
import type { HostCtx } from '../../../../src/serve/worker/host.js';
import { firestoreVerdict } from '../../../../src/serve/worker/host/observe-local-firestore.js';
import { rtdbVerdict } from '../../../../src/serve/worker/host/observe-local-rtdb.js';
import { storageVerdict } from '../../../../src/serve/worker/host/observe-local-storage.js';
import { deployFirestoreRulesToHost, setDatabaseRules } from '../../../../src/serve/worker/host/rules.js';

const DENIED_FS = { status: 'error', code: 'permission-denied' } as const;
const DENIED_RTDB = { status: 'error', code: 'permission_denied' } as const;
const DENIED_STORAGE = { status: 'error', code: 'storage/unauthorized' } as const;

function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function wrapParens(expr: string, count: number): string {
  return `${'('.repeat(count)}${expr}${')'.repeat(count)}`;
}

function makeFsHost(instanceId: string) {
  const sandbox = initializeSandbox();
  const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId,
    subs: new Map(),
    rtdbProjectId: 'demo-project',
    observedSession,
  };
  return { sandbox, observedSession, ctx };
}

describe('two-world partial-observation soundness oracle (zero false-allows)', () => {
  it('Firestore: never returns allow across parenthesized/container/duplicate-match rules when full Sandbox denies', async () => {
    const rng = createPrng(0x5b1101);

    for (let trial = 0; trial < 40; trial++) {
      const parenDepth = 1 + (trial % 3);
      const variant = trial % 4;
      const helperCall = wrapParens(`checkGuest(${wrapParens('request', 1 + (trial % 2))})`, parenDepth);
      const afterCall = wrapParens(
        `existsAfter(/databases/$(database)/documents/orgs/org-${trial})`,
        parenDepth,
      );

      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function checkGuest(req) {
      return req.auth != null && ${wrapParens('req.auth.token', parenDepth)}.get(${wrapParens("'role'", 1)}, 'guest') == 'guest';
    }
    match /items/{id} {
      function checkLocal(req) {
        return req.auth != null && req.auth.token.get('tier', 'free') == 'free';
      }
      allow get: if ${helperCall};
      allow create: if !${afterCall};
      allow update: if request.auth != null && {'tok': request.auth.token}.tok.get('email', '') == '';
      allow delete: if ${wrapParens('checkLocal(request)', parenDepth)};
    }
    match /items/{id} {
      function checkLocal(r) { return r.auth != null; }
      allow list: if false;
    }
  }
  match /databases/{database}/documents {
    function checkGuest(r) { return r.auth != null; }
    match /items/{id} { allow list: if false; }
  }
}`;

      const { sandbox, observedSession, ctx } = makeFsHost(`oracle-fs-1-${trial}`);
      expect(deployFirestoreRulesToHost(ctx, rules).ok).toBe(true);

      const adminDb = getAdminFirestore(sandbox);
      await setDoc(doc(adminDb, `orgs/org-${trial}`), { active: true });
      await setDoc(doc(adminDb, `items/item-${trial}`), { title: 'existing' });

      const authedDb = getFirestore(
        sandbox.withAuth({
          uid: `u-${trial}`,
          token: { email: `member-${trial}@example.test`, role: 'blocked', tier: 'enterprise' },
        }),
      );

      let groundTruthDenied = false;
      let call: ObservedCall;
      let obsMethod: 'get' | 'create' | 'update' | 'delete';

      if (variant === 0) {
        obsMethod = 'get';
        try {
          await getDoc(doc(authedDb, `items/item-${trial}`));
        } catch {
          groundTruthDenied = true;
        }
        call = {
          service: 'firestore',
          method: 'getDoc',
          path: `items/item-${trial}`,
          at: 1000 + trial,
          outcome: DENIED_FS,
          account: { uid: `u-${trial}`, claimNames: ['role', 'sub'] },
        };
      } else if (variant === 1) {
        obsMethod = 'create';
        try {
          await setDoc(doc(authedDb, `items/new-${trial}`), { title: 'created' });
        } catch {
          groundTruthDenied = true;
        }
        call = {
          service: 'firestore',
          method: 'setDoc',
          path: `items/new-${trial}`,
          at: 1000 + trial,
          outcome: DENIED_FS,
          account: { uid: `u-${trial}`, claimNames: ['sub'], claims: { sub: `u-${trial}` } },
          writeData: { title: 'created' },
        };
      } else if (variant === 2) {
        obsMethod = 'update';
        try {
          await updateDoc(doc(authedDb, `items/item-${trial}`), { title: 'edited' });
        } catch {
          groundTruthDenied = true;
        }
        observedSession.apply({
          firestore: [{ kind: 'set', path: `items/item-${trial}`, data: { title: 'existing' } }],
        });
        call = {
          service: 'firestore',
          method: 'updateDoc',
          path: `items/item-${trial}`,
          at: 1000 + trial,
          outcome: DENIED_FS,
          account: { uid: `u-${trial}`, claimNames: ['email', 'sub'], claims: { sub: `u-${trial}` } },
          writeData: { title: 'edited' },
        };
      } else {
        obsMethod = 'delete';
        try {
          await deleteDoc(doc(authedDb, `items/item-${trial}`));
        } catch {
          groundTruthDenied = true;
        }
        let deleteAccount: ObservedCall['account'];
        if (pick(rng, [true, false])) {
          deleteAccount = { uid: `u-${trial}`, claimNames: ['tier', 'sub'] };
        } else {
          deleteAccount = { uid: `u-${trial}`, claimNames: ['tier'], claims: { tier: 'enterprise' } };
        }
        call = {
          service: 'firestore',
          method: 'deleteDoc',
          path: `items/item-${trial}`,
          at: 1000 + trial,
          outcome: DENIED_FS,
          account: deleteAccount,
        };
      }

      expect(groundTruthDenied).toBe(true);
      const verdict = firestoreVerdict(ctx, call, obsMethod);
      expect(verdict).toBeDefined();
      expect(['deny', 'unevaluated']).toContain(verdict!.result);
      sandbox.dispose();
    }
  });

  it('Firestore: never returns allow across all 6 colliding user-map shapes and dotted session updates when full Sandbox denies', async () => {
    const rng = createPrng(0x5b2202);
    const collidingShapes: readonly {
      readonly checkExpr: (ref: string) => string;
      readonly plainMap: Record<string, unknown>;
      readonly baseMap: Record<string, unknown>;
      readonly dottedKey: string;
      readonly dottedVal: unknown;
    }[] = [
      {
        checkExpr: (ref) => `${ref} is timestamp`,
        plainMap: { __type: 'timestamp', seconds: 100, nanos: 0 },
        baseMap: { __type: 'timestamp', seconds: 100 },
        dottedKey: 'meta.nanos',
        dottedVal: 0,
      },
      {
        checkExpr: (ref) => `${ref} is bytes`,
        plainMap: { __type: 'bytes', base64: 'AQID' },
        baseMap: { __type: 'bytes' },
        dottedKey: 'meta.base64',
        dottedVal: 'AQID',
      },
      {
        checkExpr: (ref) => `${ref} is timestamp`,
        plainMap: { _methodName: 'serverTimestamp' },
        baseMap: { label: 'plain' },
        dottedKey: 'meta._methodName',
        dottedVal: 'serverTimestamp',
      },
      {
        checkExpr: (ref) => `!(${ref} is map)`,
        plainMap: { __type__: '__vector__', value: [1, 2] },
        baseMap: { __type__: '__vector__' },
        dottedKey: 'meta.value',
        dottedVal: [1, 2],
      },
      {
        checkExpr: (ref) => `${ref} is path`,
        plainMap: { type: 'document', id: 'u-1', path: 'users/u-1' },
        baseMap: { id: 'u-1', path: 'users/u-1' },
        dottedKey: 'meta.type',
        dottedVal: 'document',
      },
      {
        checkExpr: (ref) => `!(${ref} is map) || ${ref}.typeName == 'not-matched'`,
        plainMap: { typeName: 'timestamp', seconds: 50 },
        baseMap: { typeName: 'timestamp' },
        dottedKey: 'meta.seconds',
        dottedVal: 50,
      },
    ];

    for (let trial = 0; trial < 36; trial++) {
      const shape = collidingShapes[trial % collidingShapes.length]!;
      const mode = trial % 3;
      const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      allow create: if ${shape.checkExpr('request.resource.data.meta')};
      allow update: if ${shape.checkExpr('request.resource.data.meta')};
      allow delete: if ${shape.checkExpr('resource.data.meta')};
    }
  }
}`;
      const { sandbox, observedSession, ctx } = makeFsHost(`oracle-fs-2-${trial}`);
      expect(deployFirestoreRulesToHost(ctx, rules).ok).toBe(true);

      const adminDb = getAdminFirestore(sandbox);
      const clientDb = getFirestore(sandbox.withAuth({ uid: 'u-1' }));

      let groundTruthDenied = false;
      let verdictResult: string | undefined;

      if (mode === 0) {
        try {
          await setDoc(doc(clientDb, `docs/c-${trial}`), { meta: shape.plainMap });
        } catch {
          groundTruthDenied = true;
        }
        let writeMeta: Record<string, unknown> = shape.plainMap;
        if (pick(rng, [true, false])) {
          writeMeta = { type: 'pyric/map/1.0', fields: shape.plainMap };
        }
        verdictResult = firestoreVerdict(
          ctx,
          {
            service: 'firestore',
            method: 'setDoc',
            path: `docs/c-${trial}`,
            at: 2000 + trial,
            outcome: DENIED_FS,
            writeData: { meta: writeMeta },
          },
          'create',
        )?.result;
      } else if (mode === 1) {
        await setDoc(doc(adminDb, `docs/d-${trial}`), { meta: shape.plainMap });
        try {
          await deleteDoc(doc(clientDb, `docs/d-${trial}`));
        } catch {
          groundTruthDenied = true;
        }
        observedSession.apply({
          firestore: [
            { kind: 'set', path: `docs/d-${trial}`, data: { meta: { type: 'pyric/map/1.0', fields: shape.baseMap } } },
            { kind: 'update', path: `docs/d-${trial}`, data: { [shape.dottedKey]: shape.dottedVal } },
          ],
        });
        verdictResult = firestoreVerdict(
          ctx,
          { service: 'firestore', method: 'deleteDoc', path: `docs/d-${trial}`, at: 2000 + trial, outcome: DENIED_FS },
          'delete',
        )?.result;
      } else {
        await setDoc(doc(adminDb, `docs/u-${trial}`), { meta: shape.baseMap });
        try {
          await updateDoc(doc(clientDb, `docs/u-${trial}`), { [shape.dottedKey]: shape.dottedVal });
        } catch {
          groundTruthDenied = true;
        }
        observedSession.apply({
          firestore: [
            { kind: 'set', path: `docs/u-${trial}`, data: { meta: { type: 'pyric/map/1.0', fields: shape.baseMap } } },
          ],
        });
        verdictResult = firestoreVerdict(
          ctx,
          {
            service: 'firestore',
            method: 'updateDoc',
            path: `docs/u-${trial}`,
            at: 2000 + trial,
            outcome: DENIED_FS,
            writeData: { [shape.dottedKey]: shape.dottedVal },
          },
          'update',
        )?.result;
      }

      expect(groundTruthDenied).toBe(true);
      expect(verdictResult).toBeDefined();
      expect(['deny', 'unevaluated']).toContain(verdictResult!);
      sandbox.dispose();
    }
  });

  it('RTDB: never returns allow on effective-null writes with uncaptured ancestor .validate when full Sandbox denies', async () => {
    const rng = createPrng(0x5b3303);
    const effectiveNullValues: readonly unknown[] = [
      null,
      {},
      [],
      [null, {}, []],
      { a: null, nested: { b: null, emptyArr: [] } },
      { '.value': null },
      { '.priority': 1 },
      { '.priority': 'rank-1', child: {} },
    ];
    const rtdbRulesObj = {
      rules: {
        groups: {
          $gid: {
            '.write': 'auth != null',
            '.validate': "newData.hasChildren(['title', 'active'])",
          },
        },
      },
    };

    for (let trial = 0; trial < 40; trial++) {
      const { sandbox, ctx } = makeFsHost(`oracle-rtdb-${trial}`);
      expect(setDatabaseRules(ctx, undefined, rtdbRulesObj).ok).toBe(true);

      const adminRtdb = getAdminDatabase(sandbox);
      await dbSet(dbRef(adminRtdb, '/'), { groups: { [`g-${trial}`]: { title: 'Alpha', active: true } } });
      dbSandbox.setRules(adminRtdb, rtdbRulesObj);

      const authedRtdb = getDatabase(sandbox.withAuth({ uid: `u-${trial}` }));
      const useUpdate = pick(rng, [true, false]);
      const nullWrite = pick(rng, effectiveNullValues);

      let groundTruthDenied = false;
      let call: ObservedCall;
      let method: 'set' | 'update';

      if (useUpdate) {
        method = 'update';
        try {
          await dbUpdate(dbRef(authedRtdb, `groups/g-${trial}`), { active: nullWrite });
        } catch {
          groundTruthDenied = true;
        }
        call = {
          service: 'rtdb',
          method: 'update',
          instance: 'demo-project-default-rtdb',
          path: `groups/g-${trial}`,
          at: 3000 + trial,
          outcome: DENIED_RTDB,
          account: { uid: `u-${trial}` },
          writeData: { active: nullWrite } as ObservedCall['writeData'],
        };
      } else {
        method = 'set';
        try {
          await dbSet(dbRef(authedRtdb, `groups/g-${trial}/active`), nullWrite);
        } catch {
          groundTruthDenied = true;
        }
        call = {
          service: 'rtdb',
          method: pick(rng, ['set', 'setWithPriority']),
          instance: 'demo-project-default-rtdb',
          path: `groups/g-${trial}/active`,
          at: 3000 + trial,
          outcome: DENIED_RTDB,
          account: { uid: `u-${trial}` },
          writeData: nullWrite as ObservedCall['writeData'],
        };
      }

      expect(groundTruthDenied).toBe(true);
      const verdict = rtdbVerdict(ctx, call, method);
      expect(verdict).toBeDefined();
      expect(['deny', 'unevaluated']).toContain(verdict!.result);
      sandbox.dispose();
    }
  });

  it('Storage: never returns allow on uncaptured hash/storageClass fields, same-line allows, or oversized metadata when full rules deny', () => {
    const rng = createPrng(0x5b4404);
    const uncapturedFieldChecks = [
      "!('md5Hash' in request.resource)",
      "!('crc32c' in request.resource)",
      "!('storageClass' in request.resource)",
      "!('md5Hash' in {'r': request.resource}.r)",
      "!('crc32c' in [request.resource][0])",
    ] as const;
    const bucket = 'demo-project.appspot.com';

    for (let trial = 0; trial < 40; trial++) {
      const checkExpr = pick(rng, uncapturedFieldChecks);
      let createLine = `allow create: if ${checkExpr};`;
      if (pick(rng, [true, false])) {
        createLine = `allow get: if resource.size > 1000; allow create: if ${checkExpr};`;
      }

      const storageSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      ${createLine}
      allow update: if !('etag' in resource) || !('md5Hash' in request.resource);
      allow delete: if !('blocked' in resource.metadata);
    }
  }
}`;
      const sandbox = initializeSandbox();
      getStorageSandbox(sandbox, {
        dbName: `oracle-st-db-${trial}-${crypto.randomUUID()}`,
        rules: storageSource,
      });
      const compiled = compiledStorageRulesForBucket(sandbox, bucket, [bucket])!;
      const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
      const ctx: HostCtx = {
        db: getFirestore(sandbox),
        sandbox,
        instanceId: `oracle-st-${trial}`,
        subs: new Map(),
        appOptions: { projectId: 'demo-project', storageBucket: bucket },
        observedSession,
      };

      const mode = trial % 3;
      const objectPath = `items/file-${trial}.txt`;
      const fullName = `b/${bucket}/o/${objectPath}`;

      type ProdReqRes = NonNullable<Parameters<typeof evaluateStorageRules>[1]['request']['resource']>;
      const baseAccount = { uid: `u-${trial}`, claimNames: ['sub'], claims: { sub: `u-${trial}` } };
      let stVerdict: ReturnType<typeof storageVerdict>;

      if (mode === 0) {
        const prodCreate = {
          name: objectPath,
          bucket,
          size: 16,
          contentType: 'text/plain',
          md5Hash: '1B2M2Y8AsgTpgAmY7PhCfg==',
          crc32c: 'AAAAAA==',
          storageClass: 'STANDARD',
          metadata: {},
        } as unknown as ProdReqRes;
        const gt = evaluateStorageRules(
          compiled,
          { request: { auth: { uid: `u-${trial}`, token: {} }, method: 'create', path: objectPath, resource: prodCreate }, resource: null },
          new Date(4000 + trial),
        );
        expect(gt.allowed).toBe(false);
        stVerdict = storageVerdict(
          ctx,
          { service: 'storage', method: 'uploadBytes', bucket, path: objectPath, at: 4000 + trial, outcome: DENIED_STORAGE, account: baseAccount, writeData: { size: 16, contentType: 'text/plain', metadata: {} } },
          'create',
        );
      } else if (mode === 1) {
        const storedObj = {
          name: fullName,
          bucket,
          size: 16,
          contentType: 'text/plain',
          etag: 'etag-1',
          md5Hash: '1B2M2Y8AsgTpgAmY7PhCfg==',
          crc32c: 'AAAAAA==',
          storageClass: 'STANDARD',
          metadata: { tag: 'v1' },
        };
        const prodUpdate = { ...storedObj, metadata: { tag: 'v2' } } as unknown as ProdReqRes;
        const gt = evaluateStorageRules(
          compiled,
          { request: { auth: { uid: `u-${trial}`, token: {} }, method: 'update', path: objectPath, resource: prodUpdate }, resource: storedObj },
          new Date(4000 + trial),
        );
        expect(gt.allowed).toBe(false);
        stVerdict = storageVerdict(
          ctx,
          { service: 'storage', method: 'updateMetadata', bucket, path: objectPath, at: 4000 + trial, outcome: DENIED_STORAGE, account: baseAccount, document: { size: 16, contentType: 'text/plain', metadata: { tag: 'v1' } }, writeData: { metadata: { tag: 'v2' } } },
          'update',
        );
      } else {
        const gt = evaluateStorageRules(
          compiled,
          { request: { auth: { uid: `u-${trial}`, token: {} }, method: 'delete', path: objectPath }, resource: { name: fullName, bucket, size: 16, contentType: 'text/plain', metadata: { blocked: 'x'.repeat(33_000) } } },
          new Date(4000 + trial),
        );
        expect(gt.allowed).toBe(false);
        stVerdict = storageVerdict(
          ctx,
          { service: 'storage', method: 'deleteObject', bucket, path: objectPath, at: 4000 + trial, outcome: DENIED_STORAGE, account: baseAccount },
          'delete',
        );
      }
      expect(stVerdict).toBeDefined();
      expect(['deny', 'unevaluated']).toContain(stVerdict!.result);
      sandbox.dispose();
    }
  });
});
