/**
 * `QuerySnapshot.forEach` and `DocumentSnapshot.get` through the worker
 * bridge (#1203). The create-pyric node template calls `snap.forEach` on a
 * `getDocs` result; the served client had `docs` but no `forEach`, so the
 * template crashed under `pyric sandbox --hosted`. Both planes must visit the
 * same documents in the same order and read the same fields.
 *
 * The in-page side imports `pyric/*` from the package's dist, so run
 * `scripts/build.sh --packages-only` after editing the sandbox sources.
 */
import { expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getInternalEnv } from 'pyric/sandbox/internal';
import * as inPage from 'pyric/firestore';
import { FirebaseError } from 'pyric/app';
import * as client from '../../../src/serve/worker/client.js';
import { makeHostCtx, connectClientToHost, until } from './integration-support.js';

const OPEN_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /posts/{id} { allow read, write: if true; }
  }
}`;

const POSTS: Array<[string, Record<string, unknown>]> = [
  ['posts/b', { n: 2, meta: { author: 'bo', 'a.b': 'dotted' } }],
  ['posts/a', { n: 1, meta: { author: 'al' } }],
  ['posts/c', { n: 3 }],
];

interface DocLike {
  id: string;
  get(fieldPath: unknown): unknown;
}
interface SnapLike {
  forEach(callback: (...args: unknown[]) => void, thisArg?: unknown): void;
}

/**
 * What a caller observes through `forEach` and `get`. Production calls
 * `callback.call(thisArg, doc)` with the document alone.
 */
function observe(snapshot: SnapLike, fieldPath: (...segments: string[]) => unknown): unknown[] {
  const seen: unknown[] = [];
  const self = { label: 'thisArg' };
  snapshot.forEach(function (this: unknown, ...args: unknown[]) {
    const doc = args[0] as DocLike;
    seen.push({
      id: doc.id,
      argCount: args.length,
      boundThis: this === self,
      n: doc.get('n'),
      author: doc.get('meta.author'),
      dottedKey: doc.get(fieldPath('meta', 'a.b')),
      missing: doc.get('meta.nope'),
    });
  }, self);
  return seen;
}

async function inPagePlane(): Promise<{ read: unknown[]; listened: unknown[] }> {
  const sandbox = initializeSandbox();
  try {
    setRules(sandbox, OPEN_RULES);
    const db = inPage.getFirestore(sandbox);
    for (const [path, data] of POSTS) await inPage.setDoc(inPage.doc(db, path), data);
    const ordered = inPage.query(inPage.collection(db, 'posts'), inPage.orderBy('n'));
    const fieldPath = (...segments: string[]) => new inPage.FieldPath(...segments);
    const read = observe(await inPage.getDocs(ordered) as unknown as SnapLike, fieldPath);
    const snaps: SnapLike[] = [];
    const stop = inPage.onSnapshot(ordered, (s) => snaps.push(s as unknown as SnapLike));
    await until(() => snaps.length >= 1, 'in-page initial snapshot');
    stop();
    return { read, listened: observe(snaps[0]!, fieldPath) };
  } finally {
    getInternalEnv(sandbox).dispose();
  }
}

async function servedPlane(): Promise<{ read: unknown[]; listened: unknown[] }> {
  const previousWorker = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  try {
    setRules(ctx.sandbox, OPEN_RULES);
    const { db } = connectClientToHost(ctx, 'worker://query-snapshot-for-each');
    for (const [path, data] of POSTS) await client.setDoc(client.doc(db, path), data);
    const ordered = client.query(client.collection(db, 'posts'), client.orderBy('n'));
    const fieldPath = (...segments: string[]) => new inPage.FieldPath(...segments);
    const read = observe(await client.getDocs(ordered) as unknown as SnapLike, fieldPath);
    const snaps: SnapLike[] = [];
    const stop = client.onSnapshot(ordered, (s) => snaps.push(s as unknown as SnapLike));
    await until(() => snaps.length >= 1, 'served initial snapshot');
    stop();
    await client.getWorkerInstanceId(db).catch(() => undefined);
    return { read, listened: observe(snaps[0]!, fieldPath) };
  } finally {
    getInternalEnv(ctx.sandbox).dispose();
    globalThis.SharedWorker = previousWorker;
  }
}

const EXPECTED = [
  { id: 'a', argCount: 1, boundThis: true, n: 1, author: 'al', dottedKey: undefined, missing: undefined },
  { id: 'b', argCount: 1, boundThis: true, n: 2, author: 'bo', dottedKey: 'dotted', missing: undefined },
  { id: 'c', argCount: 1, boundThis: true, n: 3, author: undefined, dottedKey: undefined, missing: undefined },
];

test('a served getDocs snapshot and listener snapshot have forEach and get, as the in-page snapshots do', async () => {
  const served = await servedPlane();
  expect(served.read).toEqual(EXPECTED);
  expect(served.listened).toEqual(EXPECTED);
  const local = await inPagePlane();
  expect(local.read).toEqual(EXPECTED);
  expect(local.listened).toEqual(EXPECTED);
});

test('a served getDoc snapshot reads a nested field with get and rejects an invalid path with invalid-argument', async () => {
  const previousWorker = globalThis.SharedWorker;
  const ctx = await makeHostCtx();
  try {
    setRules(ctx.sandbox, OPEN_RULES);
    const { db } = connectClientToHost(ctx, 'worker://doc-snapshot-get');
    await client.setDoc(client.doc(db, 'posts/x'), { meta: { author: 'xi' } });
    const snap = await client.getDoc(client.doc(db, 'posts/x'));
    expect(snap.get('meta.author')).toBe('xi');
    expect(snap.get(new inPage.FieldPath('meta', 'author'))).toBe('xi');
    const missing = await client.getDoc(client.doc(db, 'posts/none'));
    expect(missing.get('meta')).toBeUndefined();
    let thrown: unknown;
    try { snap.get('meta..author'); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(FirebaseError);
    expect((thrown as FirebaseError).code).toBe('invalid-argument');
    await client.getWorkerInstanceId(db).catch(() => undefined);
  } finally {
    getInternalEnv(ctx.sandbox).dispose();
    globalThis.SharedWorker = previousWorker;
  }
});
