/**
 * DF-1 (#1247): a served page's transaction that makes a data-dependent
 * `.read` false revokes the listeners that rule guards, as a `set` does.
 * The host runs the transaction commit, so the cancellation reaches the page
 * over its port and later data never does.
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import * as client from '../../../src/serve/worker/index.js';
import { setDatabaseRules } from '../../../src/serve/worker/host/rules.js';
import { connectClientToHost, makeHostCtx, until } from './integration-support.js';

let previousWorker: unknown;
beforeEach(() => { previousWorker = (globalThis as { SharedWorker?: unknown }).SharedWorker; });
afterEach(() => { (globalThis as { SharedWorker?: unknown }).SharedWorker = previousWorker; });

const RULES = {
  rules: {
    gate: { '.read': "root.child('open').val() == true", '.write': true },
    open: { '.read': true, '.write': true },
    marker: { '.read': true, '.write': true },
  },
};

for (const applyLocally of [true, false]) {
  test(`a transaction that closes the gate cancels the gate's listeners (applyLocally ${applyLocally})`, async () => {
    const ctx = await makeHostCtx();
    setDatabaseRules(ctx, undefined, { rules: { '.read': true, '.write': true } });
    const { db } = connectClientToHost(ctx, `worker://rtdb-txn-revoke-${Math.random()}`);
    const rtdb = client.rtdbGetDatabase(db);
    await client.rtdbSet(client.rtdbRef(rtdb, 'open'), true);
    await client.rtdbSet(client.rtdbRef(rtdb, 'gate'), { a: 'initial' });
    setDatabaseRules(ctx, undefined, RULES);

    const events: string[] = [];
    const cancelled = (event: string) => (error: Error) => events.push(`${event} cancel ${(error as { code?: string }).code}`);
    client.rtdbOnValue(client.rtdbRef(rtdb, 'gate'), (snapshot) => events.push(`value ${JSON.stringify(snapshot.val())}`), cancelled('value'));
    client.rtdbOnChildAdded(client.rtdbRef(rtdb, 'gate'), (snapshot) => events.push(`added ${snapshot.key}`), cancelled('added'));
    await until(() => events.length >= 2, 'the initial value and child');

    await client.rtdbRunTransaction(client.rtdbRef(rtdb, 'open'), () => false, { applyLocally });
    await until(() => events.filter((event) => event.includes('cancel')).length >= 2, 'both cancellations');

    // The gate's rule still allows the write; nothing about it may reach the page.
    await client.rtdbSet(client.rtdbRef(rtdb, 'gate/b'), 'post-revocation');
    const markers: unknown[] = [];
    client.rtdbOnValue(client.rtdbRef(rtdb, 'marker'), (snapshot) => markers.push(snapshot.val()));
    await client.rtdbSet(client.rtdbRef(rtdb, 'marker'), 1);
    await until(() => markers.includes(1), 'the marker write');

    expect(events.sort()).toEqual([
      'added a', 'added cancel PERMISSION_DENIED', 'value cancel PERMISSION_DENIED', 'value {"a":"initial"}',
    ]);
    await expect(client.rtdbGet(client.rtdbRef(rtdb, 'gate'))).rejects.toThrow(/PERMISSION_DENIED|permission_denied/i);
  });
}
