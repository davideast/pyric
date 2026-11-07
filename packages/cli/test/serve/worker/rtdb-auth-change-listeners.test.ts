/**
 * A served page's RTDB listeners follow its port session. The host
 * re-registers them on every sign-in and sign-out; when the listener may still
 * read, its data is unchanged, so the page fires nothing.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { activeListeners } from 'pyric/sandbox';
import * as client from '../../../src/serve/worker/index.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import { connectClientToHost, makeHostCtx, until } from './integration-support.js';

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
  await until(() => events.length >= 2, 'the initial value and child');
  expect(events).toEqual(['value {"a":1}', 'added a']);

  const auth = client.getAuth(db);
  await client.signInAnonymously(auth);
  await client.signOut(auth);
  await client.signOut(auth);

  // The host delivers in order, so the events of a later write mark the point
  // by which anything the sign-in or the sign-outs fired would have arrived.
  await client.rtdbSet(client.rtdbRef(rtdb, 'items/b'), 2);
  await until(() => events.includes('added b') && events.includes('value {"a":1,"b":2}'), 'the marker write');
  expect(events.slice(0, 2)).toEqual(['value {"a":1}', 'added a']);
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
  await until(() => events.length >= 1, 'the initial value');
  await client.signOut(auth);
  await until(() => events.length >= 2, 'the cancel');
  expect(events).toEqual(['value', 'cancel PERMISSION_DENIED']);
});

test('re-authenticating an RTDB listener preserves app provenance and clientListenerId without a Firestore journeyId (#2449)', async () => {
  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, {
    rules: {
      public: { '.read': true, '.write': true },
      gated: { '.read': 'auth != null', '.write': true },
    },
  });
  const { db } = connectClientToHost(ctx, `worker://rtdb-reauth-prov-${Math.random()}`);
  const rtdb = client.rtdbGetDatabase(db);
  const auth = client.getAuth(db);
  await client.signInAnonymously(auth);

  const events: string[] = [];
  const unsubPublic = client.rtdbOnValue(client.rtdbRef(rtdb, 'public'), () => events.push('public'));
  client.rtdbOnValue(
    client.rtdbRef(rtdb, 'gated'),
    () => events.push('gated'),
    (error) => events.push(`gated-cancel ${(error as { code?: string }).code}`),
  );
  await until(() => events.includes('public') && events.includes('gated'), 'initial snapshots');

  const initialListeners = activeListeners(ctx.sandbox.history()).filter((l) => l.service === 'database');
  expect(initialListeners).toHaveLength(2);
  const publicClientId = initialListeners.find((l) => l.target.includes('public'))?.clientListenerId;
  const gatedClientId = initialListeners.find((l) => l.target.includes('gated'))?.clientListenerId;
  expect(typeof publicClientId).toBe('string');
  expect(typeof gatedClientId).toBe('string');

  const historyBeforeSignOut = ctx.sandbox.history().length;
  await client.signOut(auth);
  await until(() => events.includes('gated-cancel PERMISSION_DENIED'), 'gated cancel on sign-out');

  // Surviving public listener retains its clientListenerId after re-auth.
  const remaining = activeListeners(ctx.sandbox.history()).filter((l) => l.service === 'database');
  expect(remaining).toHaveLength(1);
  expect(remaining[0]?.clientListenerId).toBe(publicClientId);

  // Re-auth events carry app actor + reauthorize lifecycle and no Firestore journeyId.
  const reauthEvents = ctx.sandbox.history().slice(historyBeforeSignOut);
  const gatedDeny = reauthEvents.find(
    (e) => e.kind === 'operation' && e.service === 'rtdb' && e.method === 'listen' && e.result === 'deny',
  );
  const gatedErrored = reauthEvents.find(
    (e) => e.kind === 'listener' && e.service === 'rtdb' && e.phase === 'errored' && e.result === 'deny',
  );
  expect(gatedDeny).toBeDefined();
  expect(gatedDeny?.actor?.kind).toBe('app');
  expect((gatedDeny?.actor as { journeyId?: string } | undefined)?.journeyId).toBeUndefined();
  expect(gatedDeny?.activity).toEqual({
    listenerId: gatedClientId,
    listenerLifecycle: 'reauthorize',
  });
  expect(gatedErrored?.actor?.kind).toBe('app');
  expect((gatedErrored?.actor as { journeyId?: string } | undefined)?.journeyId).toBeUndefined();
  expect(gatedErrored?.activity).toEqual({
    listenerId: gatedClientId,
    listenerLifecycle: 'reauthorize',
  });

  const reattachedPublic = reauthEvents.find(
    (e) => e.kind === 'listener' && e.service === 'rtdb' && e.phase === 'attach',
  );
  expect(reattachedPublic).toBeDefined();
  expect(reattachedPublic?.actor?.kind).toBe('app');
  expect((reattachedPublic?.actor as { journeyId?: string } | undefined)?.journeyId).toBeUndefined();
  expect(reattachedPublic?.activity).toEqual({
    listenerId: publicClientId,
    listenerLifecycle: 'reauthorize',
  });

  unsubPublic();
});

test('permanently cancelled RTDB listeners do not resurrect on later signIn across initial denial, signOut revocation, or setDatabaseRules revocation (#2450)', async () => {
  const ctx = await makeHostCtx();
  setDatabaseRules(ctx, undefined, {
    rules: {
      secret: { '.read': 'auth != null', '.write': true },
      policy: { '.read': 'auth != null', '.write': true },
      marker: { '.read': true, '.write': true },
    },
  });
  const { db, hostPort } = connectClientToHost(ctx, `worker://rtdb-no-resurrect-${Math.random()}`);
  const rtdb = client.rtdbGetDatabase(db);
  const auth = client.getAuth(db);

  // Path 1: initial sub denied while signed out.
  const initialDeniedEvents: string[] = [];
  client.rtdbOnValue(
    client.rtdbRef(rtdb, 'secret'),
    (s) => initialDeniedEvents.push(`val:${JSON.stringify(s.val())}`),
    (e) => initialDeniedEvents.push(`err:${(e as { code?: string }).code}`),
  );
  await until(() => initialDeniedEvents.length >= 1, 'initial secret denial');
  expect(initialDeniedEvents).toEqual(['err:PERMISSION_DENIED']);

  // Sign in: initialDeniedEvents must NOT resurrect; attach two allowed listeners.
  await client.signInAnonymously(auth);
  await client.rtdbSet(client.rtdbRef(rtdb, 'secret'), 'v1');
  await client.rtdbSet(client.rtdbRef(rtdb, 'policy'), 'p1');

  const signOutCancelledEvents: string[] = [];
  client.rtdbOnValue(
    client.rtdbRef(rtdb, 'secret'),
    (s) => signOutCancelledEvents.push(`val:${JSON.stringify(s.val())}`),
    (e) => signOutCancelledEvents.push(`err:${(e as { code?: string }).code}`),
  );
  const rulesCancelledEvents: string[] = [];
  client.rtdbOnValue(
    client.rtdbRef(rtdb, 'policy'),
    (s) => rulesCancelledEvents.push(`val:${JSON.stringify(s.val())}`),
    (e) => rulesCancelledEvents.push(`err:${(e as { code?: string }).code}`),
  );
  await until(
    () => signOutCancelledEvents.includes('val:"v1"') && rulesCancelledEvents.includes('val:"p1"'),
    'allowed listeners initial values',
  );
  expect(initialDeniedEvents).toEqual(['err:PERMISSION_DENIED']);

  // Path 3: tighten rules via setDatabaseRules while still signed in -> cancels policy listener.
  setDatabaseRules(ctx, undefined, {
    rules: {
      secret: { '.read': 'auth != null', '.write': true },
      policy: { '.read': false, '.write': true },
      marker: { '.read': true, '.write': true },
    },
  });
  await until(() => rulesCancelledEvents.includes('err:PERMISSION_DENIED'), 'policy rule revocation');
  expect(rulesCancelledEvents).toEqual(['val:"p1"', 'err:PERMISSION_DENIED']);

  // Restore permissive policy read rule, then pipeline signOut + signIn so signIn arrives before
  // any async client unsub round-trip -> secret listener is cancelled on signOut and must NOT resurrect on signIn (Path 2).
  setDatabaseRules(ctx, undefined, {
    rules: {
      secret: { '.read': 'auth != null', '.write': true },
      policy: { '.read': 'auth != null', '.write': true },
      marker: { '.read': true, '.write': true },
    },
  });
  const markerEvents: string[] = [];
  const unsubMarker = client.rtdbOnValue(client.rtdbRef(rtdb, 'marker'), (s) =>
    markerEvents.push(`marker:${JSON.stringify(s.val())}`),
  );
  const signOutPromise = client.signOut(auth);
  const signInPromise = client.signInAnonymously(auth);
  await Promise.all([signOutPromise, signInPromise]);
  await until(() => signOutCancelledEvents.includes('err:PERMISSION_DENIED'), 'secret signOut revocation');
  await client.rtdbSet(client.rtdbRef(rtdb, 'secret'), 'v2');
  await client.rtdbSet(client.rtdbRef(rtdb, 'policy'), 'p2');
  await client.rtdbSet(client.rtdbRef(rtdb, 'marker'), 'done');
  await until(() => markerEvents.includes('marker:"done"'), 'marker flush');

  // None of the three permanently cancelled listeners may fire again or remain registered on the host.
  expect(initialDeniedEvents).toEqual(['err:PERMISSION_DENIED']);
  expect(signOutCancelledEvents).toEqual(['val:"v1"', 'err:PERMISSION_DENIED']);
  expect(rulesCancelledEvents).toEqual(['val:"p1"', 'err:PERMISSION_DENIED']);
  expect(ctx.subs.get(hostPort)?.size).toBe(1);
  expect(activeListeners(ctx.sandbox.history()).filter((l) => l.service === 'database')).toHaveLength(1);
  unsubMarker();
  await until(() => (ctx.subs.get(hostPort)?.size ?? 0) === 0, 'marker unsub on host');
  expect(activeListeners(ctx.sandbox.history()).filter((l) => l.service === 'database')).toHaveLength(0);
});
