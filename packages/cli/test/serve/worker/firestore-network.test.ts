import { describe, expect, it } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import { Timestamp } from 'pyric/firestore';
import * as client from '../../../src/serve/worker/index.js';
import { connectClientToHost, makeHostCtx, sleep } from './integration-support.ts';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read, write: if true; }
    match /denied/{id} { allow read, write: if false; }
  }
}`;

describe('worker Firestore network lifecycle and serverTimestamp options', () => {
  it('holds offline writes pending with local snapshots and flushes or rejects on enableNetwork', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, RULES);
    const { db } = connectClientToHost(host, `worker://fs-net-${Math.random()}`);

    const itemRef = client.doc(db, 'items/a');
    await client.disableNetwork(db);

    let writeSettled = false;
    const write = client.setDoc(itemRef, { status: 'queued', ts: client.serverTimestamp() }).then(() => {
      writeSettled = true;
    });
    let waitSettled = false;
    const waiting = client.waitForPendingWrites(db).then(() => {
      waitSettled = true;
    });

    await sleep(20);
    expect(writeSettled).toBe(false);
    expect(waitSettled).toBe(false);

    const offlineSnap = await client.getDoc(itemRef);
    expect(offlineSnap.exists()).toBe(true);
    expect(offlineSnap.metadata.fromCache).toBe(true);
    expect(offlineSnap.metadata.hasPendingWrites).toBe(true);
    expect(offlineSnap.data()).toEqual({ status: 'queued', ts: null });
    expect((offlineSnap.data({ serverTimestamps: 'estimate' }) as { ts?: unknown })?.ts).toBeInstanceOf(Timestamp);

    await client.enableNetwork(db);
    await Promise.all([write, waiting]);
    expect(writeSettled).toBe(true);
    expect(waitSettled).toBe(true);

    const onlineSnap = await client.getDoc(itemRef);
    expect(onlineSnap.metadata.fromCache).toBe(false);
    expect(onlineSnap.metadata.hasPendingWrites).toBe(false);
    expect((onlineSnap.data() as { ts?: unknown })?.ts).toBeInstanceOf(Timestamp);

    host.sandbox.dispose();
  });

  it('deep-merges warmed cache maps, preserves escaped marker keys, and truncates timestamps to microseconds', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, RULES);
    const { db } = connectClientToHost(host, `worker://fs-warm-${Math.random()}`);

    const nestedRef = client.doc(db, 'items/nested');
    await client.setDoc(nestedRef, {
      label: 'initial',
      meta: { note: 'alpha', count: 1, keep: true },
      stamped: new Timestamp(1_600_000_000, 999_999_999),
    });
    await client.setDoc(
      nestedRef,
      {
        meta: { count: 2, note: client.deleteField() },
      },
      { merge: true },
    );

    const escapedRef = client.doc(db, 'items/escaped');
    await client.setDoc(escapedRef, {
      type: 'custom-kind',
      meta: { a: 1 },
    });
    await client.setDoc(
      escapedRef,
      {
        label: 'merged',
        meta: { b: 2 },
      },
      { merge: true },
    );

    // Tighten rules so a new listener emits the warmed-cache snapshot before permission-denied.
    setRules(
      host.sandbox,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`,
    );

    const nestedEvents: Array<{ kind: 'snap'; data: unknown } | { kind: 'err'; code: string }> = [];
    const nestedDone = new Promise<void>((resolve) => {
      const unsub = client.onSnapshot(
        nestedRef,
        (snap) => {
          nestedEvents.push({ kind: 'snap', data: snap.data() });
        },
        (err) => {
          nestedEvents.push({ kind: 'err', code: err.code });
          unsub();
          resolve();
        },
      );
    });

    const escapedEvents: Array<{ kind: 'snap'; data: unknown } | { kind: 'err'; code: string }> = [];
    const escapedDone = new Promise<void>((resolve) => {
      const unsub = client.onSnapshot(
        escapedRef,
        (snap) => {
          escapedEvents.push({ kind: 'snap', data: snap.data() });
        },
        (err) => {
          escapedEvents.push({ kind: 'err', code: err.code });
          unsub();
          resolve();
        },
      );
    });

    await Promise.all([nestedDone, escapedDone]);

    expect(nestedEvents).toEqual([
      {
        kind: 'snap',
        data: {
          label: 'initial',
          meta: { count: 2, keep: true },
          stamped: new Timestamp(1_600_000_000, 999_999_000),
        },
      },
      { kind: 'err', code: 'permission-denied' },
    ]);
    expect(escapedEvents).toEqual([
      {
        kind: 'snap',
        data: {
          type: 'custom-kind',
          label: 'merged',
          meta: { a: 1, b: 2 },
        },
      },
      { kind: 'err', code: 'permission-denied' },
    ]);

    host.sandbox.dispose();
  });

  it('preserves settled serverTimestamp values on removed query docChanges when metadata changes are excluded', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, RULES);
    const { db } = connectClientToHost(host, `worker://fs-removed-ts-${Math.random()}`);

    const snapshots: Array<{
      ids: string[];
      changes: Array<{ type: string; id: string; stamped: unknown }>;
    }> = [];
    const q = client.query(client.collection(db, 'items'), client.limit(1));
    const unsub = client.onSnapshot(q, (snap) => {
      snapshots.push({
        ids: snap.docs.map((d) => d.id),
        changes: snap.docChanges().map((c) => ({
          type: c.type,
          id: c.doc.id,
          stamped: (c.doc.data() as { stamped?: unknown })?.stamped,
        })),
      });
    });

    await sleep(30);
    await client.setDoc(client.doc(db, 'items/b'), { stamped: client.serverTimestamp() });
    await sleep(30);
    // Writing items/a evicts items/b from the limit(1) query.
    await client.setDoc(client.doc(db, 'items/a'), { stamped: client.serverTimestamp() });
    await sleep(30);
    unsub();

    const removal = snapshots
      .flatMap((s) => s.changes)
      .find((c) => c.type === 'removed' && c.id === 'b');
    expect(removal).toBeDefined();
    expect(removal?.stamped).toBeInstanceOf(Timestamp);

    host.sandbox.dispose();
  });

  it('does not double-apply increment() in warmed cache when an active listener already recorded the host snapshot (#3223)', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, RULES);
    const { db } = connectClientToHost(host, `worker://fs-live-inc-${Math.random()}`);

    const docRef = client.doc(db, 'items/d1');
    const liveSeen: Array<Record<string, unknown> | undefined> = [];
    const unsubDoc = client.onSnapshot(docRef, (snap) => {
      liveSeen.push(snap.data());
    });
    await sleep(20);

    await client.setDoc(docRef, { label: 'pinned', n: client.increment(2) }, { merge: true });
    await client.updateDoc(docRef, { n: client.increment(3) });
    const batch = client.writeBatch(db);
    batch.update(docRef, { n: client.increment(4) });
    await batch.commit();
    await client.runTransaction(db, async (tx) => {
      await tx.get(docRef);
      tx.update(docRef, { n: client.increment(1) });
    });
    await sleep(20);
    expect(liveSeen.at(-1)).toEqual({ label: 'pinned', n: 10 });
    unsubDoc();

    setRules(
      host.sandbox,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`,
    );

    const queryEvents: Array<{ kind: 'snap'; docs: unknown[] } | { kind: 'err'; code: string }> = [];
    await new Promise<void>((resolve) => {
      const unsubQuery = client.onSnapshot(
        client.collection(db, 'items'),
        (snap) => {
          queryEvents.push({ kind: 'snap', docs: snap.docs.map((d) => d.data()) });
        },
        (err) => {
          queryEvents.push({ kind: 'err', code: err.code });
          unsubQuery();
          resolve();
        },
      );
    });

    expect(queryEvents).toEqual([
      { kind: 'snap', docs: [{ label: 'pinned', n: 10 }] },
      { kind: 'err', code: 'permission-denied' },
    ]);

    host.sandbox.dispose();
  });

  it('evaluates non-merge setDoc field transforms against the prior document in offline and warmed caches (#3286)', async () => {
    const host = await makeHostCtx();
    setRules(host.sandbox, RULES);
    const { db } = connectClientToHost(host, `worker://fs-replace-xform-${Math.random()}`);

    const docRef = client.doc(db, 'items/replace-xform');
    await client.setDoc(docRef, {
      tags: ['beta', 'gamma'],
      n: 7,
      stamped: new Timestamp(1_650_000_000, 0),
      stale: 'removed-by-replace',
    });

    await client.disableNetwork(db);
    const pendingWrite = client.setDoc(docRef, {
      label: 'archived',
      tags: client.arrayRemove('gamma', 'absent'),
      added: client.arrayUnion('delta'),
      n: client.increment(5),
      stamped: client.serverTimestamp(),
    });

    const cachedPending = await client.getDoc(docRef);
    expect(cachedPending.metadata.fromCache).toBe(true);
    expect(cachedPending.metadata.hasPendingWrites).toBe(true);
    expect(cachedPending.data()).toEqual({
      label: 'archived',
      tags: ['beta'],
      added: ['delta'],
      n: 12,
      stamped: null,
    });
    expect(
      (cachedPending.data({ serverTimestamps: 'previous' }) as { stamped?: unknown })?.stamped,
    ).toEqual(new Timestamp(1_650_000_000, 0));

    await client.enableNetwork(db);
    await pendingWrite;

    setRules(
      host.sandbox,
      `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}`,
    );

    const warmedEvents: Array<{ kind: 'snap'; docs: unknown[] } | { kind: 'err'; code: string }> = [];
    await new Promise<void>((resolve) => {
      const unsub = client.onSnapshot(
        client.collection(db, 'items'),
        (snap) => {
          warmedEvents.push({
            kind: 'snap',
            docs: snap.docs.map((d) => {
              const raw = { ...(d.data() as Record<string, unknown>) };
              delete raw.stamped;
              return raw;
            }),
          });
        },
        (err) => {
          warmedEvents.push({ kind: 'err', code: err.code });
          unsub();
          resolve();
        },
      );
    });

    expect(warmedEvents).toEqual([
      {
        kind: 'snap',
        docs: [{ label: 'archived', tags: ['beta'], added: ['delta'], n: 12 }],
      },
      { kind: 'err', code: 'permission-denied' },
    ]);

    host.sandbox.dispose();
  });
});
