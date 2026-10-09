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
import { makeHostCtx, connectClientToHost, until } from './integration-support.js';

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

const lastPaths = (snaps: Snap[]) => (snaps.length === 0 ? null : JSON.stringify(paths(snaps.at(-1)!)));

/** Resolve once the host has released every subscription the client opened. */
const released = (ctx: Awaited<ReturnType<typeof makeHostCtx>>) =>
  until(() => [...ctx.subs.values()].every((port) => port.size === 0), 'the host to release the listener');

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
    await until(() => snaps.length > 0 || errors.length > 0, 'the initial snapshot');
    expect(errors).toEqual([]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.docs).toHaveLength(0);

    await client.setDoc(client.doc(db, 'users/u1/items/a'), { n: 1 });
    await until(() => lastPaths(snaps) === '["users/u1/items/a"]', 'the nested write');
    const afterNested = snaps.length;

    await client.setDoc(client.doc(db, 'items/b'), { n: 2 });
    await until(() => lastPaths(snaps) === '["items/b","users/u1/items/a"]', 'the root write');
    const afterRoot = snaps.length;
    expect(afterRoot).toBeGreaterThan(afterNested);

    // A sibling collection's write must not fire the listener. The host
    // delivers in write order, so a later write to the group marks the point
    // by which any snapshot the sibling write caused would have arrived.
    await client.setDoc(client.doc(db, 'users/u1/other/c'), { n: 3 });
    await client.setDoc(client.doc(db, 'items/z'), { n: 4 });
    await until(() => lastPaths(snaps) === '["items/b","items/z","users/u1/items/a"]', 'the marker write');
    for (const snap of snaps.slice(afterRoot)) expect(paths(snap)).toContain('items/z');
    expect(snaps.flatMap(paths)).not.toContain('users/u1/other/c');
    expect(errors).toEqual([]);
  } finally {
    stop?.();
    await released(ctx);
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
    await until(() => fires > 0 || errors.length > 0, 'the listener to settle');
    expect(fires).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'permission-denied' });
  } finally {
    stop?.();
    await released(ctx);
    getInternalEnv(ctx.sandbox).dispose();
    globalThis.SharedWorker = previousWorker;
  }
});
