/**
 * BUNDLE-REALM SMOKE — the only test that EXECUTES the shipped SharedWorker
 * artifact.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every other worker test imports `host.ts` (or its `host/*` family modules)
 * directly from source. That is a different artifact from the one browsers
 * actually run: `pyric dev` serves an esbuild IIFE produced by `bundleWorker`,
 * which bundles `entry.ts` + the whole pyric runtime into one classic-worker
 * script. Between source and that bundle sit two failure classes no
 * source-level test can see:
 *
 *   1. CIRCULAR-IMPORT / INIT-ORDER. The host is now a barrel over `host/*`
 *      family modules. Bundling flattens that graph into ONE linear scope, so
 *      a cycle that TypeScript and the source-level tests tolerate (module
 *      records are lazy) can produce a temporal-dead-zone throw or an
 *      `undefined` binding at bundle-init time. The source suite would still
 *      be entirely green.
 *   2. TREE-SHAKE. esbuild drops what it believes is unreachable. A handler
 *      reached only through a dispatch table (exactly how this host routes)
 *      is the classic shape for an over-eager shake — the method vanishes
 *      from the shipped script while the source still exports it.
 *
 * Both regressions ship silently today. This test executes the REAL bundle and
 * drives real traffic through it, so both surface as a test failure.
 *
 * THE HARNESS REALM
 * -----------------
 * The bundle is a classic-worker IIFE that expects a `SharedWorkerGlobalScope`.
 * We evaluate it inside a `new Function` whose parameter list IS the realm: we
 * PROVIDE the browser ambients a SharedWorker has (`self`, `indexedDB`,
 * `fetch`) and deliberately WITHHOLD the node ambients it does not
 * (`process`, `global`, `Buffer`, `module`, `require`, `window`, …).
 *
 * Withholding is load-bearing, not hygiene: bundled dependencies sniff their
 * environment at init. js-md5 (pulled in by the rules evaluator) checks
 * `typeof process === 'object' && process.versions.node` and, if it sees Bun's
 * `process`, takes its node branch and dereferences `Buffer` — which the
 * browser-platform bundle never defines. Shadowing those names to `undefined`
 * makes the sniff resolve the way it does in a real browser worker, so what
 * runs here is the same code path the browser runs.
 *
 * `indexedDB` comes from fake-indexeddb (the worker attaches IDB persistence
 * on boot); `fetch` is a stub that 404s, which is the STANDALONE boot path —
 * `fetchInitPayload` swallows the failure and the worker falls back to plain
 * IDB, exactly as it does when no `pyric dev` server sits behind it.
 *
 * WHAT PROVES THE BUNDLE (not the source) IS UNDER TEST
 * ----------------------------------------------------
 * `getRuntimeEpoch` reports the build hash esbuild baked in via `define`. Imported
 * from source that value is the literal `'dev'` (see host.test.ts). Asserting
 * it is a real hash — NOT `'dev'` — is what pins this test to the artifact.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleWorker } from '../../../src/serve/bundler.js';
import type { OutboundMessage, ResMessage, SnapMessage } from '../../../src/serve/worker/protocol.js';

// ─── The harness realm ────────────────────────────────────────────────────

/** A live connection to a bundled worker: the page-side port + everything it
 *  has received. */
interface Realm {
  send(msg: unknown): void;
  replies: OutboundMessage[];
  closed(): boolean;
  close(): void;
}

/**
 * Evaluate the REAL worker bundle in a harness realm and connect one port
 * through its `onconnect`, exactly as a browser does on `new SharedWorker(...)`.
 */
async function bootBundledWorker(): Promise<Realm> {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-bundle-realm-'));
  const { outFile: file } = await bundleWorker({ outDir: dir, noCache: true, minify: false });
  const src = readFileSync(file, 'utf8');

  // The SharedWorkerGlobalScope the bundle installs its `onconnect` on.
  let workerClosed = false;
  const workerSelf: {
    onconnect?: (e: { ports: unknown[] }) => void;
    close(): void;
  } = {
    close() { workerClosed = true; },
  };

  // Standalone boot: no `pyric dev` behind the worker, so /__pyric/init.json
  // 404s and buildWorkerCtx falls back to plain IDB.
  const fetchStub = async () => ({ ok: false, status: 404, json: async () => ({}) });

  // The parameter list IS the realm — see the header. Everything passed
  // `undefined` is a node ambient a real SharedWorker does not have.
  const evaluate = new Function(
    'self', 'indexedDB', 'fetch',
    'process', 'global', 'Buffer', 'window', 'module', 'exports', 'require', 'define', 'EventSource',
    src,
  );
  evaluate(
    workerSelf, globalThis.indexedDB, fetchStub,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  );

  // A bundle whose init order broke would have thrown above; a bundle that
  // never wired the connect handler fails here.
  if (typeof workerSelf.onconnect !== 'function') {
    throw new Error('bundled worker did not install an onconnect handler');
  }

  const channel = new MessageChannel();
  const replies: OutboundMessage[] = [];
  channel.port1.onmessage = (ev: MessageEvent) => void replies.push(ev.data as OutboundMessage);
  channel.port1.start();

  // The connect event a browser dispatches for each tab.
  workerSelf.onconnect({ ports: [channel.port2] });

  return {
    replies,
    closed: () => workerClosed,
    send: (msg) => channel.port1.postMessage(msg),
    close: () => {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

// ─── Message helpers ──────────────────────────────────────────────────────

/** Let the port's message queue and the sandbox's async work drain. */
function settle(ms = 250): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Await the `res` for an op id (the port hop is async). */
async function awaitRes(realm: Realm, id: string, timeoutMs = 5_000): Promise<ResMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = realm.replies.find((m): m is ResMessage => m.t === 'res' && m.id === id);
    if (res) return res;
    if (Date.now() > deadline) throw new Error(`timed out waiting for res '${id}'`);
    await settle(25);
  }
}

async function sendOp(realm: Realm, msg: { id: string; method: string } & Record<string, unknown>): Promise<ResMessage> {
  realm.send({ t: 'op', ...msg });
  return awaitRes(realm, msg.id);
}

function okValue<T>(res: ResMessage): T {
  if (!res.ok) throw new Error(`Expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as T;
}

const snapsFor = (realm: Realm, subId: string): SnapMessage[] =>
  realm.replies.filter((m): m is SnapMessage => m.t === 'snap' && m.subId === subId);

// ─── The smoke ────────────────────────────────────────────────────────────
//
// ONE realm for the whole file: a SharedWorker IS a singleton, and re-booting
// per test would have each fresh sandbox restore the previous one's state out
// of the shared fake-indexeddb (the worker's persistence key is fixed), making
// the tests order-dependent. Each test below uses its own doc paths / subIds.

describe('bundle realm — the shipped SharedWorker artifact executes', () => {
  let realm: Realm;

  beforeAll(async () => {
    realm = await bootBundledWorker();
  }, 60_000);

  afterAll(() => realm?.close());

  it('answers the BAKED epoch before the sandbox context has to initialize', async () => {
    const res = await sendOp(realm, { id: 'realm-version', method: 'getRuntimeEpoch' });
    const value = okValue<{ version: string }>(res);

    // A real esbuild-injected hash — NOT the 'dev' the source-imported host
    // reports. This is what proves the BUNDLE is the thing under test.
    expect(value.version).not.toBe('dev');
    expect(value.version).toMatch(/^[0-9a-f]{8,}$/);
  }, 30_000);

  it('round-trips a firestore write + read through the bundled sandbox', async () => {
    const write = await sendOp(realm, {
      id: 'realm-write', method: 'setDoc', path: 'realm-items/one', data: { v: 1 },
    });
    expect(write.ok).toBe(true);

    const read = await sendOp(realm, {
      id: 'realm-read', method: 'getDocs',
      source: { __ref: 'collection', path: 'realm-items' },
    });
    const docs = okValue<{ docs: Array<{ id: string; data: { json: string } }> }>(read).docs;

    expect(docs.map((d) => d.id)).toEqual(['one']);
    expect(JSON.parse(docs[0]!.data.json)).toEqual({ v: 1 });
  }, 30_000);

  it('delivers a live snapshot on sub, and STOPS on unsub', async () => {
    const SUB = 'realm-sub';
    realm.send({ t: 'sub', subId: SUB, target: { __ref: 'collection', path: 'realm-watch' } });
    await settle();

    // Initial fire.
    expect(snapsFor(realm, SUB).length).toBeGreaterThanOrEqual(1);

    // A write reaches the live listener.
    await sendOp(realm, {
      id: 'realm-sub-write', method: 'setDoc', path: 'realm-watch/a', data: { n: 1 },
    });
    await settle();
    const afterWrite = snapsFor(realm, SUB);
    expect(afterWrite.length).toBeGreaterThan(1);
    const latest = afterWrite.at(-1)!.value as { docs?: Array<{ id: string }> };
    expect(latest.docs?.map((d) => d.id)).toEqual(['a']);

    // ── unsub tears the listener down in the bundled host ──
    realm.send({ t: 'unsub', subId: SUB });
    await settle();
    const countAtUnsub = snapsFor(realm, SUB).length;

    // A further write must reach NOBODY.
    await sendOp(realm, {
      id: 'realm-post-unsub-write', method: 'setDoc', path: 'realm-watch/b', data: { n: 2 },
    });
    await settle();
    expect(snapsFor(realm, SUB).length).toBe(countAtUnsub);
  }, 30_000);

  it('retires the shipped worker only after acknowledging and notifying the page', async () => {
    const response = await sendOp(realm, {
      id: 'realm-retire', method: 'retireRuntime', targetEpoch: 'fedcba9876543210',
    });
    expect(response.ok).toBe(true);
    await settle(100);

    expect(realm.replies).toContainEqual({
      t: 'runtime-reload', epoch: 'fedcba9876543210',
    });
    expect(realm.closed()).toBe(true);
  }, 30_000);
});
