/**
 * Composite `or()` / `and()` over the SharedWorker THROUGH the served
 * `firebase/firestore` entry (issue #144).
 *
 * `composite-filters.test.ts` proves the host rebuilds composite descriptors,
 * and `integration.test.ts` proves the real client↔host round-trip. What was
 * still broken is the LAST MILE: `entries/firestore.ts` — the bundle the import
 * map serves for `firebase/firestore` — stubbed `or`/`and` on the worker path
 * with a throwing `unsupportedComposite`, so a real app under `pyric dev`
 * calling `or(where(...), where(...))` failed even though the whole protocol
 * already carries the composite filter tree.
 *
 * This test imports that ENTRY module (not the raw worker client) with a
 * SharedWorker shim wired to a real host, exactly as a served page would, and
 * asserts composite queries return the correct documents over the worker.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore as ipGetFirestore } from 'pyric/firestore';
import type { FirebaseApp } from 'pyric/app';

const PERMISSIVE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /{document=**} { allow read, write: if true; }
  }
}`;

const sleep = (ms = 30) => new Promise((r) => setTimeout(r, ms));

interface FakePort {
  postMessage(msg: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  start(): void;
  close(): void;
  addEventListener(type: string, fn: () => void): void;
}
function portPair(): { a: FakePort; b: FakePort } {
  const a: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  const b: FakePort = { onmessage: null, postMessage() {}, start() {}, close() {}, addEventListener() {} };
  a.postMessage = (msg) => setTimeout(() => b.onmessage?.({ data: msg }), 0);
  b.postMessage = (msg) => setTimeout(() => a.onmessage?.({ data: msg }), 0);
  return { a, b };
}

async function makeHostCtx(): Promise<HostCtx> {
  const sandbox = initializeSandbox();
  const { getFirestore: adm } = await import('pyric/sandbox/admin-firestore');
  adm(sandbox.withAuth(null)).setRules(PERMISSIVE_RULES);
  return { db: ipGetFirestore(sandbox), sandbox, instanceId: 'composite-served-entry', subs: new Map() };
}

// The served firestore entry, imported ONCE after the SharedWorker shim + host
// are installed (runtime.ts picks the worker path at module-load and can't be
// re-picked, so the whole file exercises the worker path).
type FirestoreEntry = typeof import('../../../src/serve/entries/firestore.js');
type AppEntry = typeof import('pyric/app');
let fs: FirestoreEntry;
let db: ReturnType<FirestoreEntry['getFirestore']>;
let restore: () => void;
let appEntry: AppEntry;
let fixtureApp: FirebaseApp;

beforeAll(async () => {
  const ctx = await makeHostCtx();
  const { a: clientPort, b: hostPort } = portPair();
  const hostPortLike: PortLike = { postMessage: (m: OutboundMessage) => hostPort.postMessage(m) };
  hostPort.onmessage = (ev) => { void handleMessage(ctx, hostPortLike, ev.data as InboundMessage); };

  const g = globalThis as {
    SharedWorker?: unknown;
    fetch?: typeof fetch;
    __PYRIC_FORCE_INPAGE__?: boolean;
  };
  const prevSW = g.SharedWorker;
  const prevFetch = g.fetch;
  // Worker path: SharedWorker present, not forced in-page.
  g.SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  // runtime.ts fires a fire-and-forget /__pyric/init.json bridge probe on the
  // worker path; stub fetch so it resolves quietly instead of hitting the net.
  g.fetch = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  restore = () => {
    g.SharedWorker = prevSW;
    g.fetch = prevFetch;
  };

  // The served app entry is a re-export of this registry after binding it to
  // the page runtime. Vite SSR smoke tests can bind that process-global module
  // first, so reuse its one allowed config while giving this fixture its own
  // disposable app/service container.
  appEntry = await import('pyric/app');
  const priorFixture = appEntry.getApps().find((app) => app.name === 'composite-served-entry-worker-test');
  if (priorFixture) await appEntry.deleteApp(priorFixture);
  const options = appEntry.getApps()[0]?.options ?? { projectId: 'composite-served-entry' };
  fixtureApp = appEntry.initializeApp(options, 'composite-served-entry-worker-test');
  fs = await import('../../../src/serve/entries/firestore.js');
  db = fs.getFirestore(fixtureApp);
  await sleep();

  // Seed through the SERVED entry so the whole write path is the worker one too.
  const items: Array<[string, Record<string, unknown>]> = [
    ['a', { cat: 'x', n: 1 }],
    ['b', { cat: 'x', n: 5 }],
    ['c', { cat: 'y', n: 5 }],
    ['d', { cat: 'z', n: 9 }],
  ];
  for (const [docId, data] of items) {
    await fs.setDoc(fs.doc(db, `items/${docId}`), data);
  }
  await sleep();
});

afterAll(async () => {
  if (fixtureApp) await appEntry.deleteApp(fixtureApp);
  restore?.();
});

async function ids(...constraints: unknown[]): Promise<string[]> {
  const snap = await fs.getDocs(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fs.query(fs.collection(db, 'items'), ...(constraints as any[])),
  );
  return (snap as { docs: Array<{ id: string }> }).docs.map((d) => d.id).sort();
}

describe('composite or()/and() over the SharedWorker via the served firebase/firestore entry', () => {
  it('does not export a throwing composite stub on the worker path', () => {
    // The regression: these were `unsupportedComposite` stubs.
    expect(() => fs.or(fs.where('cat', '==', 'x'), fs.where('cat', '==', 'y'))).not.toThrow();
    expect(() => fs.and(fs.where('cat', '==', 'x'), fs.where('n', '>=', 5))).not.toThrow();
  });

  it('flat or(where, where) returns the union of matches', async () => {
    expect(await ids(fs.or(fs.where('cat', '==', 'x'), fs.where('cat', '==', 'y'))))
      .toEqual(['a', 'b', 'c']);
  });

  it('flat and(where, where) returns the intersection of matches', async () => {
    expect(await ids(fs.and(fs.where('cat', '==', 'x'), fs.where('n', '>=', 5))))
      .toEqual(['b']);
  });

  it('nested or(and(...), where) crosses the worker protocol intact', async () => {
    // or(and(cat==x, n>=5), cat==z) → b, d
    expect(await ids(
      fs.or(fs.and(fs.where('cat', '==', 'x'), fs.where('n', '>=', 5)), fs.where('cat', '==', 'z')),
    )).toEqual(['b', 'd']);
  });

  it('nested and(or(...), where) crosses the worker protocol intact', async () => {
    // and(or(cat==x, cat==y), n==5) → b, c
    expect(await ids(
      fs.and(fs.or(fs.where('cat', '==', 'x'), fs.where('cat', '==', 'y')), fs.where('n', '==', 5)),
    )).toEqual(['b', 'c']);
  });

  it('composite composes with orderBy/limit over the worker', async () => {
    const snap = await fs.getDocs(
      fs.query(
        fs.collection(db, 'items'),
        fs.or(fs.where('cat', '==', 'x'), fs.where('cat', '==', 'y')),
        fs.orderBy('n', 'desc'),
        fs.limit(2),
      ),
    );
    // n=5 tie between b and c breaks on the implicit key ordering (DESC) → c, b.
    expect((snap as { docs: Array<{ id: string }> }).docs.map((d) => d.id)).toEqual(['c', 'b']);
  });
});
