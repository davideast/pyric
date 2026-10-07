/**
 * A collection-group listener through the worker bridge: the host resolves the
 * group descriptor and subscribes with the sandbox's collection-group listener,
 * so the client receives the initial snapshot, writes to every collection with
 * the id at any depth, and denials through the error callback.
 */
import { expect, test } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import * as client from '../../../src/serve/worker/client.js';
import { makeHostCtx, connectClientToHost, sleep } from './integration-support.js';

const rules = (inner: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
${inner}
  }
}`;

const LISTEN_RULES = rules(`
    match /{path=**}/items/{id} { allow read, write: if true; }
    match /users/{uid}/other/{id} { allow read, write: if true; }`);

interface Snap {
  docs: { ref: { path: string } }[];
}

const paths = (snap: Snap) => snap.docs.map((d) => d.ref.path).sort();

test('a served collection-group listener receives writes under users/u1/items and items, and nothing from a sibling collection', async () => {
  const previousWorker = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  let stop: (() => void) | undefined;
  try {
    setRules(ctx.sandbox, LISTEN_RULES);
    const { db } = connectClientToHost(ctx, 'worker://collection-group-listener');
    const snaps: Snap[] = [];
    const errors: unknown[] = [];
    stop = client.onSnapshot(client.collectionGroup(db, 'items'), (s) => snaps.push(s as unknown as Snap), (e) => errors.push(e));
    await sleep();
    expect(errors).toEqual([]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.docs).toHaveLength(0);

    await client.setDoc(client.doc(db, 'users/u1/items/a'), { n: 1 });
    await sleep();
    expect(snaps.length).toBeGreaterThan(1);
    expect(paths(snaps.at(-1)!)).toEqual(['users/u1/items/a']);
    const afterNested = snaps.length;

    await client.setDoc(client.doc(db, 'items/b'), { n: 2 });
    await sleep();
    expect(snaps.length).toBeGreaterThan(afterNested);
    expect(paths(snaps.at(-1)!)).toEqual(['items/b', 'users/u1/items/a']);
    const afterRoot = snaps.length;

    await client.setDoc(client.doc(db, 'users/u1/other/c'), { n: 3 });
    await sleep();
    expect(snaps.length).toBe(afterRoot);
    expect(errors).toEqual([]);
  } finally {
    stop?.();
    await sleep();
    getInternalEnv(ctx.sandbox).dispose();
    globalThis.SharedWorker = previousWorker;
  }
});

test('a served collection-group listener under concrete collection rules receives permission-denied', async () => {
  const previousWorker = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  let stop: (() => void) | undefined;
  try {
    setRules(ctx.sandbox, rules(`
    match /items/{id} { allow read: if true; }
    match /users/{uid}/items/{id} { allow read: if true; }`));
    const { db } = connectClientToHost(ctx, 'worker://collection-group-listener-denied');
    const errors: unknown[] = [];
    let fires = 0;
    stop = client.onSnapshot(client.collectionGroup(db, 'items'), () => fires++, (e) => errors.push(e));
    await sleep();
    expect(fires).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'permission-denied' });
  } finally {
    stop?.();
    await sleep();
    getInternalEnv(ctx.sandbox).dispose();
    globalThis.SharedWorker = previousWorker;
  }
});
