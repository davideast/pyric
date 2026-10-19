/**
 * SharedWorker protocol codecs, transaction read-set canonicalization, and
 * inbound validation regression suite (issue #1124 — PR Stream 5).
 *
 * Covers:
 *   - SW-PRO-1a/b: `getSnapshot` host encoding + client rehydration preserves
 *     all `RulesValue` wrapper instances (`Timestamp`, `Bytes`, `GeoPoint`,
 *     `DocumentReference`, `VectorValue`, `Duration`, `Path`), special IEEE-754
 *     numbers (`NaN`, `Infinity`, `-Infinity`, `-0`), and escaped marker-shaped
 *     user maps across `MessagePort` for Studio `rerunAgainstRules` and
 *     `forkFromSavedState`.
 *   - SW-PRO-2a/b/c/d: `admin.getDocument`, `admin.listDocuments`,
 *     `admin.readState`, and `getSnapshot` encode `RulesBytes` (`Uint8Array`)
 *     and sibling wrappers into JSON-safe wire markers so `createHostedRuntime`
 *     relay transport never rejects binary payloads.
 *   - SW-PRO-3a/b/c: `txnCommit` read-set canonicalization avoids false
 *     equalities between real `Timestamp`s and user `{ __type: 'timestamp' }`
 *     maps, between `{ typeName: 'bytes', data: { text: 'v1' | 'v2' } }` maps,
 *     and between `{ typeName: 'path', segments, bindings }` maps, while still
 *     committing unmodified typed docs without phantom aborts.
 *   - SW-PRO-4a..e: Inbound validation refuses malformed `storage.putBytes`,
 *     `listSubcollections`, `setRules`, `setFirestoreRules`,
 *     `messaging.subscribeToTopic` / `messaging.unsubscribeFromTopic`, and
 *     malformed Firestore query constraints (`where`, `orderBy`, `limit`,
 *     `limitToLast`) at the boundary with `invalid-argument`.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSandboxRoot } from 'pyric/sandbox/internal';
import { createMemoryBackend } from 'pyric/sandbox';
import { openStorageBackend } from '../../../../pyric/src/storage/persistence.js';
import {
  getFirestore as getSandboxFirestore,
  doc as sDoc,
  setDoc as sSetDoc,
  getDoc as sGetDoc,
  Timestamp,
  Bytes,
  GeoPoint,
  vector,
} from 'pyric/firestore';
import { Duration as RulesDuration, Path as RulesPath } from 'pyric/rules/internal';
import { rerunAgainstRules } from '../../../../studio/src/features/rules-debug/rerun.js';
import { forkFromSavedState } from '../../../../studio/src/shell/saved-state-branches.js';

import { createHostedRuntime } from '../../../src/serve/hosted/runtime.js';
import { handleMessage, ensureAuth, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { refuseInvalidInboundMessage } from '../../../src/serve/worker/inbound-validation.js';
import {
  getFirestore as getWorkerFirestore,
  getSnapshot,
  doc,
  setDoc,
  getDoc,
  runTransaction,
} from '../../../src/serve/worker/client.js';

function connectClientOverMessageChannel(ctx: HostCtx) {
  const ch = new MessageChannel();
  ch.port1.onmessage = (ev) => {
    void handleMessage(ctx, ch.port1, ev.data);
  };
  ch.port1.start();
  const hadSharedWorker = 'SharedWorker' in globalThis;
  const prevSharedWorker = globalThis.SharedWorker;
  globalThis.SharedWorker = class extends EventTarget {
    port = ch.port2;
  } as unknown as typeof SharedWorker;
  try {
    return {
      clientDb: getWorkerFirestore(`http://localhost/worker-${ctx.instanceId ?? Math.random()}.js`),
      close: () => {
        ch.port1.close();
        ch.port2.close();
      },
    };
  } finally {
    if (hadSharedWorker) globalThis.SharedWorker = prevSharedWorker;
    else Reflect.deleteProperty(globalThis, 'SharedWorker');
  }
}

describe('SW-PRO-1: getSnapshot wire codec & client rehydration', () => {
  const TYPED_RULES = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if resource.data.ts is timestamp
                  && resource.data.raw is bytes
                  && resource.data.loc is latlng
                  && resource.data.ref.id == 'alice'
                  && resource.data.dur is duration
                  && resource.data.route is path;
      allow write: if true;
    }
  }
}
`;

  const PERMISSIVE_RULES = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}
`;

  it('rehydrates wrapper types, special IEEE-754 numbers, and marker-shaped plain maps across MessagePort', async () => {
    const sandbox = createSandboxRoot();
    const db = getSandboxFirestore(sandbox);
    const ctx: HostCtx = {
      sandbox,
      db,
      instanceId: 'sw-pro-1-test',
      subs: new Map(),
    };
    ensureAuth(ctx);

    const { clientDb, close } = connectClientOverMessageChannel(ctx);
    try {
      await sSetDoc(sDoc(db, 'items/one'), {
        ts: Timestamp.fromMillis(1700000000000),
        raw: Bytes.fromUint8Array(new Uint8Array([1, 2, 3])),
        loc: new GeoPoint(37.7749, -122.4194),
        ref: sDoc(db, 'users/alice'),
        embedding: vector([0.25, 0.5, 0.75]),
        nanVal: Number.NaN,
        posInf: Number.POSITIVE_INFINITY,
        negInf: Number.NEGATIVE_INFINITY,
        negZero: -0,
        literalTsMarker: { __type: 'timestamp', seconds: 42, nanos: 0 },
        literalNumMarker: { __type: 'number', value: 'NaN' },
      });
      // Inject rules-only Duration & Path wrappers via admin plane so every wrapper type is exercised.
      const existing = sandbox.admin.getDocument('items/one')!;
      sandbox.admin.setDocument('items/one', {
        ...existing,
        dur: new RulesDuration(12, 0),
        route: new RulesPath(['users', 'alice'], { uid: 'alice' }),
      });

      const denial = {
        id: 'ev-1',
        at: Date.now(),
        service: 'firestore' as const,
        method: 'get' as const,
        path: 'items/one',
        auth: null,
      };

      const inProcessSnap = sandbox.snapshot();
      const workerSnap = await getSnapshot(clientDb);

      const inProcessRerun = (await rerunAgainstRules(inProcessSnap, denial, TYPED_RULES, inProcessSnap)).result.outcome;
      const workerRerun = (await rerunAgainstRules(workerSnap, denial, TYPED_RULES, workerSnap)).result.outcome;
      expect(inProcessRerun).toBe('allow');
      expect(workerRerun).toBe('allow');

      const docSnap = workerSnap.firestore['items/one'] as Record<string, unknown>;
      expect(Number.isNaN(docSnap.nanVal)).toBe(true);
      expect(docSnap.posInf).toBe(Number.POSITIVE_INFINITY);
      expect(docSnap.negInf).toBe(Number.NEGATIVE_INFINITY);
      expect(Object.is(docSnap.negZero, -0)).toBe(true);
      expect(docSnap.literalTsMarker).toEqual({ __type: 'timestamp', seconds: 42, nanos: 0 });
      expect(docSnap.literalNumMarker).toEqual({ __type: 'number', value: 'NaN' });
      expect((docSnap.route as RulesPath).bindings).toEqual({ uid: 'alice' });

      const branch = await forkFromSavedState(workerSnap, PERMISSIVE_RULES);
      const branchDb = getSandboxFirestore(branch.sandbox);
      const readBack = (await sGetDoc(sDoc(branchDb, 'items/one'))).data()!;
      expect(readBack.ts).toBeInstanceOf(Timestamp);
      expect(readBack.raw).toBeInstanceOf(Bytes);
      expect(Array.from((readBack.raw as Bytes).toUint8Array())).toEqual([1, 2, 3]);
      expect(readBack.loc).toBeInstanceOf(GeoPoint);
      expect(Number.isNaN(readBack.nanVal)).toBe(true);
      expect(Object.is(readBack.negZero, -0)).toBe(true);
      expect(readBack.literalTsMarker).toEqual({ __type: 'timestamp', seconds: 42, nanos: 0 });
    } finally {
      close();
    }
  });
});

describe('SW-PRO-2: JSON-safe encoding across hosted worker-op relay', () => {
  it('relays admin.getDocument, admin.listDocuments, admin.readState, and getSnapshot without binary payload errors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-sw-pro-2-suite-'));
    const sent: Array<{ id?: string; ok?: boolean; result?: unknown; error?: { message?: string } }> = [];
    const mockPersistence = {
      backend: createMemoryBackend(),
      storage: await openStorageBackend('mem-sw-pro-2-suite'),
      checkpoints: {},
      state: { seed: async () => false },
      repairedObjects: [],
      sweep: Promise.resolve({ removed: 0, bytesRemoved: 0 }),
      close() {},
      status: () => ({ state: 'healthy' as const }),
      onFailure: () => () => {},
      markUnhealthy() {},
    };

    const runtime = await createHostedRuntime(
      {
        rules:
          'rules_version = "2"; service cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }',
        rulesHash: null,
        bridgeUrl: null,
        seed: null,
        capture: false,
        hosted: true,
        projectKey: 'test-proj',
        sessionToken: 'tok-1',
      },
      'http://127.0.0.1:4400',
      (msg) => sent.push(msg as { id?: string; ok?: boolean; result?: unknown; error?: { message?: string } }),
      dir,
      { persistence: mockPersistence as never, record: false },
    );

    try {
      runtime.receive({
        type: 'worker-op',
        id: 'op-set',
        clientSessionId: 'c1',
        op: {
          t: 'op',
          id: 'op-set',
          method: 'setDoc',
          path: 'items/one',
          data: { raw: { __type: 'bytes', base64: 'AQID' }, label: 'hello' },
        },
      });

      const ops = [
        ['admin.getDocument', { t: 'op', id: 'admin.getDocument', method: 'admin.getDocument', path: 'items/one' }],
        ['admin.getDocument.missing', { t: 'op', id: 'admin.getDocument.missing', method: 'admin.getDocument', path: 'items/missing' }],
        ['admin.listDocuments', { t: 'op', id: 'admin.listDocuments', method: 'admin.listDocuments', path: 'items' }],
        ['admin.readState', { t: 'op', id: 'admin.readState', method: 'admin.readState' }],
        ['getSnapshot', { t: 'op', id: 'getSnapshot', method: 'getSnapshot' }],
      ] as const;

      for (const [id, op] of ops) {
        runtime.receive({
          type: 'worker-op',
          id,
          clientSessionId: 'c1',
          op,
        });
      }

      await new Promise((r) => setTimeout(r, 80));

      for (const [id] of ops) {
        const reply = sent.find((m) => m.id === id);
        expect(reply?.ok).toBe(true);
        expect(reply?.error).toBeUndefined();
      }
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SW-PRO-3: collision-free txnCommit read-set canonicalization', () => {
  it('aborts and retries on all marker/clone-lookalike concurrent mutations without phantom aborts on typed docs', async () => {
    const sandbox = createSandboxRoot();
    await sandbox.enablePersistence({ backend: 'memory' });
    const db = getSandboxFirestore(sandbox);
    const ctx: HostCtx = { sandbox, db, instanceId: 'sw-pro-3-suite', subs: new Map() };
    ensureAuth(ctx);

    const { clientDb, close } = connectClientOverMessageChannel(ctx);
    try {
      // Case A: Real Timestamp replaced by plain map { __type: 'timestamp', seconds, nanos }
      const refA = doc(clientDb, 'items/caseA');
      await setDoc(refA, { v: Timestamp.fromMillis(1700000000000), counter: 1 });
      let attemptsA = 0;
      let sawPlainMapInA = false;
      await runTransaction(clientDb, async (tx) => {
        attemptsA++;
        const snap = await tx.get(refA);
        const v = (snap.data() as Record<string, unknown>).v;
        sawPlainMapInA = !(v instanceof Timestamp);
        if (attemptsA === 1) {
          await setDoc(refA, { v: { __type: 'timestamp', seconds: 1700000000, nanos: 0 }, counter: 1 });
        }
        tx.update(refA, { sawPlainMapInA });
      });
      expect(attemptsA).toBe(2);
      expect(sawPlainMapInA).toBe(true);

      // Case B: Plain user map { typeName: 'bytes', data: { text: 'v1' } } -> { text: 'v2' }
      const refB = doc(clientDb, 'items/caseB');
      await setDoc(refB, { payload: { typeName: 'bytes', data: { text: 'v1' } } });
      let attemptsB = 0;
      await runTransaction(clientDb, async (tx) => {
        attemptsB++;
        const snap = await tx.get(refB);
        const text = ((snap.data() as { payload: { data: { text: string } } }).payload.data.text);
        if (attemptsB === 1) {
          await setDoc(refB, { payload: { typeName: 'bytes', data: { text: 'v2' } } });
        }
        tx.update(refB, { seenText: text });
      });
      const finalB = (await getDoc(refB)).data() as { seenText: string };
      expect(attemptsB).toBe(2);
      expect(finalB.seenText).toBe('v2');

      // Case C: Plain user map { typeName: 'path', segments: ['a'], bindings: { x: 1 } } -> { x: 2 }
      const refC = doc(clientDb, 'items/caseC');
      await setDoc(refC, { route: { typeName: 'path', segments: ['a'], bindings: { x: 1 } } });
      let attemptsC = 0;
      await runTransaction(clientDb, async (tx) => {
        attemptsC++;
        const snap = await tx.get(refC);
        const x = (snap.data() as { route: { bindings: { x: number } } }).route.bindings.x;
        if (attemptsC === 1) {
          await setDoc(refC, { route: { typeName: 'path', segments: ['a'], bindings: { x: 2 } } });
        }
        tx.update(refC, { seenX: x });
      });
      const finalC = (await getDoc(refC)).data() as { seenX: number };
      expect(attemptsC).toBe(2);
      expect(finalC.seenX).toBe(2);

      // Unmodified rich typed doc commits on first attempt (zero phantom aborts)
      const refTyped = doc(clientDb, 'items/unmodifiedTyped');
      await setDoc(refTyped, {
        ts: Timestamp.fromMillis(1700000000000),
        raw: Bytes.fromUint8Array(new Uint8Array([9, 8, 7])),
        loc: new GeoPoint(40.7128, -74.006),
        ref: doc(clientDb, 'users/alice'),
        count: 10,
      });
      let typedAttempts = 0;
      await runTransaction(clientDb, async (tx) => {
        typedAttempts++;
        const snap = await tx.get(refTyped);
        tx.update(refTyped, { count: ((snap.data() as { count: number }).count) + 1 });
      });
      expect(typedAttempts).toBe(1);
    } finally {
      close();
    }
  });
});

describe('SW-PRO-4: inbound boundary validation & query constraint validation', () => {
  it('refuses malformed operation frames and malformed query constraints at the boundary with invalid-argument', () => {
    const malformedMessages: Array<Record<string, unknown>> = [
      { t: 'op', id: 'putBytes-no-dataB64', method: 'storage.putBytes', path: 'a.txt' },
      { t: 'op', id: 'putBytes-numeric-dataB64', method: 'storage.putBytes', path: 'a.txt', dataB64: 123 },
      { t: 'op', id: 'listSubcollections-no-docPath', method: 'listSubcollections' },
      { t: 'op', id: 'setRules-no-source', method: 'setRules' },
      { t: 'op', id: 'setFirestoreRules-no-source', method: 'setFirestoreRules' },
      { t: 'op', id: 'subscribeToTopic-no-topic', method: 'messaging.subscribeToTopic' },
      { t: 'op', id: 'subscribeToTopic-bad-tokens', method: 'messaging.subscribeToTopic', topic: 'news', tokens: [123] },
      { t: 'op', id: 'unsubscribeFromTopic-no-tokens', method: 'messaging.unsubscribeFromTopic', topic: 'news' },
      {
        t: 'op',
        id: 'getDocs-malformed-where',
        method: 'getDocs',
        source: {
          __ref: 'query',
          source: { __ref: 'collection', path: 'users' },
          constraints: [{ kind: 'where' }],
        },
      },
      {
        t: 'op',
        id: 'count-malformed-orderBy',
        method: 'count',
        source: {
          __ref: 'query',
          source: { __ref: 'collection', path: 'users' },
          constraints: [{ kind: 'orderBy', field: 'age', direction: 'sideways' }],
        },
      },
      {
        t: 'op',
        id: 'aggregate-malformed-limit',
        method: 'aggregate',
        spec: { total: { kind: 'count' } },
        source: {
          __ref: 'query',
          source: { __ref: 'collection', path: 'users' },
          constraints: [{ kind: 'limit', n: 0 }],
        },
      },
      {
        t: 'op',
        id: 'getDocs-malformed-limitToLast',
        method: 'getDocs',
        source: {
          __ref: 'query',
          source: { __ref: 'collection', path: 'users' },
          constraints: [{ kind: 'limitToLast', n: -5 }],
        },
      },
    ];

    for (const msg of malformedMessages) {
      const replies: Array<{ ok?: boolean; error?: { code?: string; message?: string } }> = [];
      const port: PortLike = {
        postMessage(reply) {
          replies.push(reply as { ok?: boolean; error?: { code?: string; message?: string } });
        },
      };
      const refused = refuseInvalidInboundMessage(port, msg);
      expect(refused).toBe(true);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.ok).toBe(false);
      expect(replies[0]?.error?.code).toBe('invalid-argument');
    }

    // Wire-cloned `FieldPath` / `documentId()` (`{ _internalPath: { segments: [...] } }`) must pass validation.
    const validFieldPathFrame = JSON.parse(
      JSON.stringify({
        t: 'op',
        id: 'getDocs-valid-fieldpath',
        method: 'getDocs',
        source: {
          __ref: 'query',
          source: { __ref: 'collection', path: 'users' },
          constraints: [
            { kind: 'where', field: { _internalPath: { segments: ['__name__'], offset: 0, len: 1 } }, op: '==', value: 'one' },
            { kind: 'orderBy', field: { _internalPath: { segments: ['score'], offset: 0, len: 1 } }, direction: 'asc' },
          ],
        },
      }),
    ) as Record<string, unknown>;
    const validPort: PortLike = { postMessage() {} };
    expect(refuseInvalidInboundMessage(validPort, validFieldPathFrame)).toBe(false);
  });
});
