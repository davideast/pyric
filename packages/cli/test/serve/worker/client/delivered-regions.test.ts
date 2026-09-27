/** A served listener records the page regions its callback changed. */
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import { setRules } from 'pyric/sandbox/firestore';
import { configureListenerAttribution, createSdkActivityJournal, sdkActivity, type SdkActivityRecord } from 'pyric/sandbox/internal';
import * as client from '../../../../src/serve/worker/client.js';
import { rtdbGetDatabase, rtdbRef } from '../../../../src/serve/worker/client/rtdb-references.js';
import { rtdbOnValue } from '../../../../src/serve/worker/client/rtdb-listeners.js';
import { rtdbSet } from '../../../../src/serve/worker/client/rtdb-writes.js';
import { createDeliveredRegionStore, deliveredRegions, onDeliveredRegions } from '../../../../src/serve/worker/client/listener-delivery.js';
import { makeHostCtx, connectClientToHost, sleep } from '../integration-support.js';

const host = globalThis as { document?: unknown; MutationObserver?: unknown; SharedWorker?: unknown };
let restore: () => void = () => {};
let page: Document;

beforeEach(() => {
  const previous = { document: host.document, MutationObserver: host.MutationObserver, SharedWorker: host.SharedWorker };
  const dom = new JSDOM('<!doctype html><body><p id="live">Loading</p><p id="value">Loading</p></body>');
  page = dom.window.document;
  host.document = page;
  host.MutationObserver = dom.window.MutationObserver;
  restore = () => {
    host.document = previous.document;
    host.MutationObserver = previous.MutationObserver;
    host.SharedWorker = previous.SharedWorker;
    dom.window.close();
  };
});
afterEach(() => restore());

function subscriptionIds(): string[] {
  return sdkActivity.records().filter((record: SdkActivityRecord) => record.kind === 'subscription').map(record => record.id);
}

it('records the element a Firestore snapshot callback wrote, keyed by the activity id', async () => {
  const ctx = await makeHostCtx();
  setRules(ctx.sandbox, 'rules_version = "2"; service cloud.firestore { match /databases/{db}/documents { match /notes/{id} { allow read, write: if true; } } }');
  const { db } = connectClientToHost(ctx, 'worker://delivered-regions-firestore');
  const before = new Set(subscriptionIds());
  let changes = 0;
  const stopWatching = onDeliveredRegions(() => { changes += 1; });
  const stop = client.onSnapshot(client.doc(db, 'notes/one'), snapshot => {
    page.querySelector('#live')!.textContent = String((snapshot as { exists(): boolean }).exists());
  });
  try {
    await sleep();
    const id = subscriptionIds().find(candidate => !before.has(candidate))!;
    expect(id).toBeDefined();
    expect(deliveredRegions(id)).toEqual(['#live']);
    expect(changes).toBeGreaterThan(0);
  } finally {
    stop();
    stopWatching();
  }
});

it('records the element an RTDB value callback wrote, and keeps the last regions when a delivery changes nothing', async () => {
  const ctx = await makeHostCtx();
  const { db } = connectClientToHost(ctx, 'worker://delivered-regions-rtdb');
  const node = rtdbRef(rtdbGetDatabase(db), 'scores');
  const before = new Set(subscriptionIds());
  let writes = 0;
  const stop = rtdbOnValue(node, snapshot => {
    writes += 1;
    if (writes === 1) page.querySelector('#value')!.textContent = JSON.stringify(snapshot.val());
  });
  try {
    await sleep();
    const id = subscriptionIds().find(candidate => !before.has(candidate))!;
    expect(deliveredRegions(id)).toEqual(['#value']);
    await rtdbSet(node, { ada: 1 });
    await sleep();
    expect(writes).toBe(2);
    expect(deliveredRegions(id)).toEqual(['#value']);
  } finally {
    stop();
  }
});

it('forgets the regions once the journal removes the activity', () => {
  const journal = createSdkActivityJournal({ retentionMs: 0, correlationWindowMs: 0 });
  const store = createDeliveredRegionStore(journal);
  const activity = journal.begin({ app: {}, method: 'onValue', kind: 'subscription', source: { service: 'database', target: 'gone', key: 'gone' } });
  store.record(activity.id, () => { page.querySelector('#value')!.textContent = 'seen'; });
  expect(store.regions(activity.id)).toEqual(['#value']);
  activity.close();
  journal.records();
  expect(store.regions(activity.id)).toEqual([]);
  store.dispose();
  journal.dispose();
});

it('runs the callback and records nothing while listener attribution is off', () => {
  const journal = createSdkActivityJournal();
  const store = createDeliveredRegionStore(journal);
  const activity = journal.begin({ app: {}, method: 'onValue', kind: 'subscription', source: { service: 'database', target: 'off', key: 'off' } });
  let ran = false;
  try {
    configureListenerAttribution('off');
    store.record(activity.id, () => { ran = true; page.querySelector('#value')!.textContent = 'off'; });
  } finally {
    configureListenerAttribution('auto');
  }
  expect(ran).toBe(true);
  expect(store.regions(activity.id)).toEqual([]);
  store.dispose();
  journal.dispose();
});
