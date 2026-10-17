/**
 * Worker-plane Firestore sandbox enforcement regression suite (PR 1 of #1058):
 * - FS-ENF-1: `txnCommit` re-read enforces `get` security rules when ACL is
 *   revoked between `txn.get` and `txnCommit`.
 * - FS-ENF-2b: Worker client `wirePort` rejects RPCs and `onSnapshot` errors
 *   with `FirebaseError` (`instanceof FirebaseError === true`).
 *   Evidence: `observations/firestore/firestore-read-denied-error-code.json`.
 * - FS-ENF-3a: Denied document `onSnapshot` on worker client carries `denialContext`.
 * - FS-ENF-6: Worker `runTransaction` enforces read-before-write
 *   (`failed-precondition`), respects `{ maxAttempts }`, and rejects with
 *   `code: 'failed-precondition'` on retry exhaustion.
 *   Evidence: `observations/firestore/firestore-transaction-contention-retries.json`.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { FirebaseError } from 'pyric/app';
import { getFirestore as getAdminCompatFirestore } from 'pyric/sandbox/admin-firestore';
import { getFirestore } from 'pyric/firestore';
import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { ClientPort } from '../../../src/serve/worker/client/handles.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import * as workerClient from '../../../src/serve/worker/client.js';

let workerSeq = 0;

function createWorkerHarness(rules: string, documents: Record<string, Record<string, unknown>> = {}) {
  const sandbox = initializeSandbox();
  const compat = getAdminCompatFirestore(sandbox.withAuth({ uid: 'u1' }));
  compat.setRules(rules);
  if (Object.keys(documents).length > 0) {
    compat.seed({ documents });
  }
  const db = getFirestore(sandbox);
  const ctx: HostCtx = {
    sandbox,
    db,
    instanceId: `fs-enf-worker-${++workerSeq}`,
    subs: new Map(),
  };

  let interceptInbound: ((msg: InboundMessage) => Promise<void> | void) | undefined;
  const hostPort: PortLike = {
    postMessage(message: OutboundMessage) {
      queueMicrotask(() => {
        clientPort.onmessage?.(new MessageEvent('message', { data: message }));
      });
    },
  };
  const clientPort: ClientPort = {
    onmessage: null,
    postMessage(message: InboundMessage) {
      queueMicrotask(async () => {
        if (interceptInbound) {
          await interceptInbound(message);
        }
        await handleMessage(ctx, hostPort, message);
      });
    },
    start() {},
    close() {
      clientPort.onmessage = null;
    },
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };

  const wdb = workerClient.getFirestore(`worker://fs-enf-${workerSeq}`);
  return {
    sandbox,
    db,
    wdb,
    setInboundInterceptor(fn: ((msg: InboundMessage) => Promise<void> | void) | undefined) {
      interceptInbound = fn;
    },
    dispose() {
      clientPort.close();
      sandbox.dispose();
    },
  };
}

describe('worker Firestore sandbox enforcement (FS-ENF-1, FS-ENF-2b, FS-ENF-3a, FS-ENF-6)', () => {
  it('FS-ENF-1: txnCommit re-read enforces get security rules when ACL is revoked before commit', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /secret/{id} {
      allow read: if exists(/databases/$(database)/documents/acl/allow);
    }
    match /acl/{id} {
      allow read, write: if true;
    }
    match /out/{id} {
      allow read, write: if true;
    }
  }
}`;
    const harness = createWorkerHarness(rules, {
      'secret/s1': { classified: 'launch-codes' },
      'acl/allow': { ok: true },
    });

    try {
      let caught: unknown = null;
      try {
        await workerClient.runTransaction(harness.wdb, async (tx) => {
          const snap = await tx.get(workerClient.doc(harness.wdb, 'secret/s1'));
          await workerClient.deleteDoc(workerClient.doc(harness.wdb, 'acl/allow'));
          tx.set(workerClient.doc(harness.wdb, 'out/o1'), { leaked: snap.data() });
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(FirebaseError);
      expect((caught as FirebaseError).code).toBe('permission-denied');
      const outSnap = await workerClient.getDoc(workerClient.doc(harness.wdb, 'out/o1'));
      expect(outSnap.exists()).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  it('FS-ENF-2b & FS-ENF-3a: worker wirePort rejects RPCs and doc onSnapshot errors with FirebaseError + denialContext', async () => {
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;
    const harness = createWorkerHarness(rules, { 'items/i1': { v: 1 } });

    try {
      const rpcOperations: Array<[string, () => Promise<unknown>]> = [
        ['getDoc', () => workerClient.getDoc(workerClient.doc(harness.wdb, 'items/i1'))],
        ['getDocs', () => workerClient.getDocs(workerClient.collection(harness.wdb, 'items'))],
        ['setDoc', () => workerClient.setDoc(workerClient.doc(harness.wdb, 'items/i2'), { v: 2 })],
        ['writeBatch.commit', () => {
          const b = workerClient.writeBatch(harness.wdb);
          b.set(workerClient.doc(harness.wdb, 'items/i2'), { v: 2 });
          return b.commit();
        }],
        ['runTransaction', () => workerClient.runTransaction(harness.wdb, async (tx) => {
          tx.set(workerClient.doc(harness.wdb, 'items/i2'), { v: 2 });
        })],
      ];

      for (const [label, op] of rpcOperations) {
        const err = await op().catch((e) => e);
        expect(err, `${label} should reject with FirebaseError`).toBeInstanceOf(FirebaseError);
        expect((err as FirebaseError).name).toBe('FirebaseError');
        expect((err as FirebaseError).code).toBe('permission-denied');
        expect((err as FirebaseError & { denialContext?: unknown }).denialContext).toBeDefined();
      }

      const snapErr = await new Promise<unknown>((resolve) => {
        workerClient.onSnapshot(
          workerClient.doc(harness.wdb, 'items/i1'),
          () => {},
          (err) => resolve(err),
        );
      });
      expect(snapErr).toBeInstanceOf(FirebaseError);
      expect((snapErr as FirebaseError).name).toBe('FirebaseError');
      expect((snapErr as FirebaseError).code).toBe('permission-denied');
      expect((snapErr as FirebaseError & { denialContext?: unknown }).denialContext).toBeDefined();
    } finally {
      harness.dispose();
    }
  });

  it('FS-ENF-6: worker runTransaction enforces read-before-write, respects maxAttempts, and throws failed-precondition on exhaustion', async () => {
    // Evidence: observations/firestore/firestore-transaction-contention-retries.json
    const rules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}`;
    const harness = createWorkerHarness(rules, { 'docs/d1': { n: 0 } });

    try {
      // 1. Read after write inside worker runTransaction -> failed-precondition
      const rawErr = await workerClient.runTransaction(harness.wdb, async (tx) => {
        tx.set(workerClient.doc(harness.wdb, 'docs/d1'), { n: 1 });
        await tx.get(workerClient.doc(harness.wdb, 'docs/d1'));
      }).catch((e) => e);
      expect(rawErr).toBeInstanceOf(FirebaseError);
      expect((rawErr as FirebaseError).code).toBe('failed-precondition');

      // 2 & 3. Contention retry respects { maxAttempts: 2 } and rejects with failed-precondition
      let bumpCounter = 0;
      harness.setInboundInterceptor((msg) => {
        if (msg.t === 'op' && msg.method === 'txnCommit') {
          harness.sandbox.admin.setDocument('docs/d1', { n: ++bumpCounter });
        }
      });

      let attempts = 0;
      const exhaustedErr = await workerClient.runTransaction(
        harness.wdb,
        async (tx) => {
          attempts++;
          const snap = await tx.get(workerClient.doc(harness.wdb, 'docs/d1'));
          tx.set(workerClient.doc(harness.wdb, 'docs/d1'), { n: ((snap.data()?.n as number) ?? 0) + 10 });
        },
        { maxAttempts: 2 },
      ).catch((e) => e);

      expect(attempts).toBe(2);
      expect(exhaustedErr).toBeInstanceOf(FirebaseError);
      expect((exhaustedErr as FirebaseError).code).toBe('failed-precondition');
    } finally {
      harness.dispose();
    }
  });
});
