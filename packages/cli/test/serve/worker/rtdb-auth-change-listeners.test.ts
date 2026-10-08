/**
 * A served page's RTDB listeners follow its port session. The host
 * re-registers them on every sign-in and sign-out; when the listener may still
 * read, its data is unchanged, so the page fires nothing.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as client from '../../../src/serve/worker/index.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import { connectClientToHost, makeHostCtx, sleep } from './integration-support.js';

let previousWorker: unknown;
beforeEach(() => { previousWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker; });
afterEach(() => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previousWorker; });

test('sign-in and sign-out deliver nothing to a listener that may still read', async () => {
  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, { rules: { '.read': true, '.write': true } });
  const { db } = connectClientToHost(ctx, `worker://rtdb-auth-change-${Math.random()}`);
  const rtdb = client.rtdbGetDatabase(db);
  await client.rtdbSet(client.rtdbRef(rtdb, 'items/a'), 1);
  const events: string[] = [];
  client.rtdbOnValue(client.rtdbRef(rtdb, 'items'), (snapshot) => events.push(`value ${JSON.stringify(snapshot.val())}`));
  client.rtdbOnChildAdded(client.rtdbRef(rtdb, 'items'), (snapshot) => events.push(`added ${snapshot.key}`));
  await sleep();
  expect(events).toEqual(['value {"a":1}', 'added a']);

  const auth = client.getAuth(db);
  await client.signInAnonymously(auth);
  await sleep();
  await client.signOut(auth);
  await sleep();
  await client.signOut(auth);
  await sleep();
  expect(events).toEqual(['value {"a":1}', 'added a']);

  await client.rtdbSet(client.rtdbRef(rtdb, 'items/b'), 2);
  await sleep();
  expect(events.slice(2).sort()).toEqual(['added b', 'value {"a":1,"b":2}']);
});

test('sign-out cancels a listener the signed-out page may not read', async () => {
  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, { rules: { '.read': 'auth != null', '.write': true } });
  const { db } = connectClientToHost(ctx, `worker://rtdb-auth-change-${Math.random()}`);
  const rtdb = client.rtdbGetDatabase(db);
  const auth = client.getAuth(db);
  await client.signInAnonymously(auth);
  const events: string[] = [];
  client.rtdbOnValue(client.rtdbRef(rtdb, 'items'), () => events.push('value'), (error) => events.push(`cancel ${(error as { code?: string }).code}`));
  await sleep();
  await client.signOut(auth);
  await sleep();
  expect(events).toEqual(['value', 'cancel PERMISSION_DENIED']);
});
