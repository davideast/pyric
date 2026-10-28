/**
 * `onSnapshot` with an observer object through the worker bridge (#1358,
 * FP-3). Production accepts `onSnapshot(target, { next, error, complete })`
 * and `onSnapshot(target, options, observer)`, and the committed observation
 * `firestore-row-84-observer-object-form` shows the observer fires exactly as
 * a bare callback does. The served client read the observer as listen
 * options, so `next` never ran and every frame threw "callback is not a
 * function" out of the port's message handler, which crashes a Node host.
 * An observer without `error` reports a denied listen the way the SDK does:
 * one console error, nothing thrown.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setRules } from 'pyric/sandbox/firestore';
import * as client from '../../../src/serve/worker/client.js';
import { connectClientToHost, makeHostCtx, until } from './integration-support.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /open/{id} { allow read, write: if true; }
    match /closed/{id} { allow read, write: if false; }
  }
}`;

let previousWorker: unknown;
beforeEach(() => { previousWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker; });
afterEach(() => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previousWorker; });

async function servedDb(): Promise<ReturnType<typeof client.getFirestore>> {
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, RULES);
  return connectClientToHost(ctx, `worker://observer-form-${Math.random()}`).db;
}

interface Delivered { exists?: boolean; size?: number }

test('a doc listener given { next, error } receives the initial snapshot and a write', async () => {
  const db = await servedDb();
  const ref = client.doc(db, 'open/a');
  const seen: Delivered[] = [];
  const errors: unknown[] = [];
  const stop = client.onSnapshot(ref, {
    next: (snap) => seen.push({ exists: (snap as client.ClientDocSnapshot).exists() }),
    error: (error) => errors.push(error),
  });
  await until(() => seen.length === 1, 'the initial snapshot');
  await client.setDoc(ref, { n: 1 });
  await until(() => seen.length === 2, 'the written snapshot');
  stop();
  expect(seen).toEqual([{ exists: false }, { exists: true }]);
  expect(errors).toEqual([]);
});

test('a query listener given { next, error } receives the initial snapshot and a write', async () => {
  const db = await servedDb();
  const seen: Delivered[] = [];
  const stop = client.onSnapshot(client.collection(db, 'open'), {
    next: (snap) => seen.push({ size: (snap as client.ClientQuerySnapshot).size }),
    error: () => {},
  });
  await until(() => seen.length === 1, 'the initial snapshot');
  await client.setDoc(client.doc(db, 'open/q'), { n: 1 });
  await until(() => seen.length === 2, 'the written snapshot');
  stop();
  expect(seen).toEqual([{ size: 0 }, { size: 1 }]);
});

test('the options-then-observer form delivers to the observer', async () => {
  const db = await servedDb();
  const ref = client.doc(db, 'open/b');
  const seen: Delivered[] = [];
  const stop = client.onSnapshot(ref, { includeMetadataChanges: true }, {
    next: (snap) => seen.push({ exists: (snap as client.ClientDocSnapshot).exists() }),
  });
  await until(() => seen.length === 1, 'the initial snapshot');
  stop();
  expect(seen).toEqual([{ exists: false }]);
});

test('an observer error handler receives a denied listen', async () => {
  const db = await servedDb();
  const codes: unknown[] = [];
  const stop = client.onSnapshot(client.doc(db, 'closed/x'), {
    next: () => {},
    error: (error) => codes.push((error as { code?: unknown }).code),
  });
  await until(() => codes.length === 1, 'the listen error');
  stop();
  expect(codes).toEqual(['permission-denied']);
});

test('an observer with { next } alone survives a denied listen and logs it once', async () => {
  const db = await servedDb();
  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    const stop = client.onSnapshot(client.doc(db, 'closed/y'), { next: () => {} });
    await until(() => logged.length > 0, 'the uncaught listen error');
    stop();
  } finally {
    console.error = original;
  }
  expect(logged).toHaveLength(1);
  expect(String(logged[0]![0])).toContain('Uncaught Error in snapshot listener');
  expect((logged[0]![1] as { code?: unknown }).code).toBe('permission-denied');
});
