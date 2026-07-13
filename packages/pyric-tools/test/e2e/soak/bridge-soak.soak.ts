/**
 * Real-browser soak suite for the bridge lifecycle layer.
 *
 * Every scenario runs the REAL stack end to end: a spawned
 * `pyric dev --ui --bridge --no-open --port 0 --json` serve, real Chromium
 * pages (app fixture + Pyric Studio) whose SharedWorker hosts the one
 * sandbox, and a real Node-side remote client (`@pyric/cli/remote`) over
 * the bridge WS — the exact topology where five live-only bugs hid from
 * ~7k green headless tests (Studio-tab peer, origin split, first-run child
 * race, duplicate snapshots on re-registration, perpetual peer-slot
 * fighting).
 *
 * Observation points (no product code added):
 *  - `window.__wsLog` (test init script) counts each tab's bridge `hello`
 *    registrations + close codes (4001 = replaced → standby).
 *  - `/__pyric/health` (`sandboxConnected`) — the same signal the standby
 *    poller and the dev-runner's first-run gate consume.
 *  - the Node client's own listener callbacks (emission counts/payloads).
 */
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { connectRemoteSandbox, type RemoteSandbox } from '@pyric/cli/remote';
import {
  CLI_PATH,
  McpHttpClient,
  WS_INSTRUMENTATION,
  health,
  sleep,
  startSoakServe,
  waitFor,
  waitForPeer,
  type PageWsLog,
  type SoakServe,
} from './harness.js';

// ─── shared helpers ─────────────────────────────────────────────────────────

/**
 * Lens for the suite's Firestore SUBSCRIPTIONS. Deliberately NOT
 * `{ mode: 'admin' }`: this suite found that a Firestore snapshot listener
 * registered through the admin (rules-bypass) handle still rule-evaluates
 * its reads as UNAUTHENTICATED and errors `permission-denied` under any
 * auth-gated ruleset — ops bypass rules, listeners don't (see the dedicated
 * scenario 7 below, which pins that finding). The impersonation lens gives
 * the lifecycle scenarios a working listener so their invariants (dedup,
 * handoff, fidelity) stay observable.
 */
const OBSERVER_LENS = { mode: 'as', uid: 'soak-observer' } as const;

const wsLog = (page: Page): Promise<PageWsLog> =>
  page.evaluate(() => (window as unknown as { __wsLog: PageWsLog }).__wsLog);

/** Parse the worker's serialized Firestore doc snapshot. */
function parseDocSnap(value: unknown): { exists: boolean; data: Record<string, unknown> | null } {
  const snap = value as { exists: boolean; data?: { json: string } };
  return { exists: snap.exists, data: snap.data ? (JSON.parse(snap.data.json) as Record<string, unknown>) : null };
}

/** Collects listener emissions + errors for exact-count assertions. */
function makeCollector() {
  const values: unknown[] = [];
  const errors: Error[] = [];
  return {
    values,
    errors,
    onSnap: (v: unknown) => values.push(v),
    onError: (e: Error) => errors.push(e),
  };
}

/**
 * Open two real tabs against the serve in a settled state: `first` connects
 * and registers, `second` registers after it and wins the last-wins slot,
 * `first` observes close 4001 and goes standby. Deterministic ordering —
 * each step waits on an observable.
 */
async function openTwoTabs(
  context: BrowserContext,
  serve: SoakServe,
  order: { first: string; second: string },
): Promise<{ standbyTab: Page; winnerTab: Page }> {
  const first = await context.newPage();
  await first.goto(order.first);
  await waitForPeer(serve.info.url);
  await waitFor('first tab registered (hello sent)', async () => (await wsLog(first)).hellos >= 1);

  const second = await context.newPage();
  await second.goto(order.second);
  await waitFor('second tab registered (hello sent)', async () => (await wsLog(second)).hellos >= 1, {
    timeoutMs: 20_000,
  });
  // The replacement is the observable settlement signal: the first tab's
  // socket must close with the REPLACED code (4001) and enter standby.
  await waitFor('first tab replaced (close 4001)', async () =>
    (await wsLog(first)).closes.includes(4001),
  );
  await waitForPeer(serve.info.url);
  return { standbyTab: first, winnerTab: second };
}

async function newInstrumentedContext(browser: import('@playwright/test').Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await context.addInitScript(WS_INSTRUMENTATION);
  return context;
}

// ─── scenarios ───────────────────────────────────────────────────────────────

test.describe('bridge lifecycle soak', () => {
  test('1. two-tab steady-state soak: zero spurious emissions, stable peer slot, slow op mid-soak', async ({ browser }) => {
    test.setTimeout(145_000);
    const serve = await startSoakServe();
    const context = await newInstrumentedContext(browser);
    let sb: RemoteSandbox | null = null;
    try {
      expect(serve.info.uiUrl, 'serve must expose Studio (--ui)').toBeTruthy();
      const { standbyTab, winnerTab } = await openTwoTabs(context, serve, {
        first: serve.info.url,
        second: serve.info.uiUrl!,
      });

      sb = await connectRemoteSandbox({ url: serve.info.url });
      await sb.channel.op({ method: 'setDoc', path: 'soak/doc', data: { n: 0 }, actAs: { mode: 'admin' } });
      await sb.rtdb.set('soak/presence', { on: true });

      const doc = makeCollector();
      const rtdb = makeCollector();
      const unsubDoc = sb.channel.subscribe(
        { target: { __ref: 'doc', path: 'soak/doc' }, actAs: OBSERVER_LENS },
        doc.onSnap,
        doc.onError,
      );
      const unsubRtdb = sb.rtdb.onValue('soak/presence', rtdb.onSnap, rtdb.onError);
      await waitFor('initial snapshots', () => doc.values.length >= 1 && rtdb.values.length >= 1);
      expect(doc.values).toHaveLength(1);
      expect(rtdb.values).toHaveLength(1);
      expect(parseDocSnap(doc.values[0]).data).toEqual({ n: 0 });

      // Baseline AFTER settle: any further hello is a peer-slot fight.
      const helloBaseline = {
        standby: (await wsLog(standbyTab)).hellos,
        winner: (await wsLog(winnerTab)).hellos,
      };
      expect(helloBaseline).toEqual({ standby: 1, winner: 1 });

      // ── the soak: ~60s of real time, health sampled every 2s ──
      const SOAK_MS = 60_000;
      const started = Date.now();
      const healthSamples: boolean[] = [];
      let slowOpMeta: unknown = null;
      let slowOpError: Error | null = null;
      while (Date.now() - started < SOAK_MS) {
        await sleep(2_000);
        healthSamples.push((await health(serve.info.url))?.sandboxConnected === true);
        // Mid-soak (once, ~30s in): a deliberately slow-ish op — 8 MiB
        // (the relay cap) through putBytes must complete, not 'unavailable'.
        if (slowOpMeta === null && slowOpError === null && Date.now() - started >= SOAK_MS / 2) {
          const bytes = new Uint8Array(8 * 1024 * 1024).fill(0xab);
          try {
            slowOpMeta = await sb.storage.putBytes('soak/blob.bin', bytes, {
              contentType: 'application/octet-stream',
            });
          } catch (e) {
            slowOpError = e as Error;
          }
        }
      }

      // Invariants.
      expect(slowOpError, `mid-soak 8 MiB putBytes failed: ${slowOpError?.message}`).toBeNull();
      expect(slowOpMeta).toBeTruthy();
      expect(await sb.storage.exists('soak/blob.bin')).toBe(true);
      expect(healthSamples.length).toBeGreaterThanOrEqual(25);
      expect(
        healthSamples.every((s) => s === true),
        `health flapped during soak: ${JSON.stringify(healthSamples)}`,
      ).toBe(true);
      // ZERO emissions beyond the initials.
      expect(doc.values, `spurious doc emissions: ${JSON.stringify(doc.values.slice(1))}`).toHaveLength(1);
      expect(rtdb.values, `spurious rtdb emissions: ${JSON.stringify(rtdb.values.slice(1))}`).toHaveLength(1);
      expect(doc.errors).toHaveLength(0);
      expect(rtdb.errors).toHaveLength(0);
      // Peer-slot stability: not one additional hello registration on either tab.
      expect(await wsLog(standbyTab).then((l) => l.hellos)).toBe(helloBaseline.standby);
      expect(await wsLog(winnerTab).then((l) => l.hellos)).toBe(helloBaseline.winner);

      unsubDoc();
      unsubRtdb();
    } finally {
      sb?.close();
      await context.close();
      await serve.stop();
    }
  });

  test('2. change fidelity under two tabs: exactly N emissions, correct payloads, in order', async ({ browser }) => {
    const serve = await startSoakServe();
    const context = await newInstrumentedContext(browser);
    let sb: RemoteSandbox | null = null;
    try {
      const { standbyTab } = await openTwoTabs(context, serve, {
        first: serve.info.url, // app tab first (ends standby)
        second: serve.info.uiUrl!, // Studio wins the slot
      });

      sb = await connectRemoteSandbox({ url: serve.info.url });
      await sb.channel.op({ method: 'setDoc', path: 'soak/fidelity', data: { seq: 0 }, actAs: { mode: 'admin' } });

      const doc = makeCollector();
      const unsub = sb.channel.subscribe(
        { target: { __ref: 'doc', path: 'soak/fidelity' }, actAs: OBSERVER_LENS },
        doc.onSnap,
        doc.onError,
      );
      await waitFor('initial snapshot', () => doc.values.length >= 1);

      // N spaced edits driven from the BROWSER (the app tab's page client →
      // SharedWorker), exercising browser→server delivery while a different
      // tab (Studio) holds the peer slot.
      const N = 5;
      for (let i = 1; i <= N; i++) {
        await standbyTab.evaluate(
          ([path, seq]) =>
            (window as unknown as { __soak: { setDoc(p: string, d: unknown): Promise<void> } }).__soak.setDoc(
              path as string,
              { seq },
            ),
          ['soak/fidelity', i] as const,
        );
        await sleep(400);
      }

      await waitFor(`exactly ${N} change emissions`, () => doc.values.length >= 1 + N, { timeoutMs: 10_000 });
      await sleep(1_500); // quiet window: nothing further may arrive
      expect(doc.values, `emissions: ${JSON.stringify(doc.values.map(parseDocSnap))}`).toHaveLength(1 + N);
      expect(doc.errors).toHaveLength(0);
      const seqs = doc.values.map((v) => parseDocSnap(v).data?.seq);
      expect(seqs).toEqual([0, 1, 2, 3, 4, 5]); // correct payloads, order preserved
      unsub();
    } finally {
      sb?.close();
      await context.close();
      await serve.stop();
    }
  });

  test('3. tab refresh mid-listen: dedup holds, exactly one emission for the post-refresh change', async ({ browser }) => {
    const serve = await startSoakServe();
    const context = await newInstrumentedContext(browser);
    let sb: RemoteSandbox | null = null;
    try {
      // Studio first (ends standby, keeps the SharedWorker alive across the
      // refresh), app tab second — the app tab HOLDS the peer slot.
      const { winnerTab } = await openTwoTabs(context, serve, {
        first: serve.info.uiUrl!,
        second: serve.info.url,
      });

      sb = await connectRemoteSandbox({ url: serve.info.url });
      await sb.channel.op({ method: 'setDoc', path: 'soak/refresh', data: { n: 1 }, actAs: { mode: 'admin' } });
      const doc = makeCollector();
      const unsub = sb.channel.subscribe(
        { target: { __ref: 'doc', path: 'soak/refresh' }, actAs: OBSERVER_LENS },
        doc.onSnap,
        doc.onError,
      );
      await waitFor('initial snapshot', () => doc.values.length >= 1);

      // Refresh the peer-holding tab. The slot churns (standby tab may claim
      // and be re-replaced by the reloaded page) — every re-issued initial
      // snapshot is byte-identical, so NOTHING may reach the listener.
      await winnerTab.reload();
      await waitForPeer(serve.info.url);
      await sleep(3_000); // full churn + re-issue window
      expect(
        doc.values,
        `refresh re-fired the listener: ${JSON.stringify(doc.values.map(parseDocSnap))}`,
      ).toHaveLength(1);
      expect(doc.errors).toHaveLength(0);

      // A write AFTER the refresh delivers exactly once.
      await sb.channel.op({ method: 'setDoc', path: 'soak/refresh', data: { n: 2 }, actAs: { mode: 'admin' } });
      await waitFor('post-refresh emission', () => doc.values.length >= 2, { timeoutMs: 10_000 });
      await sleep(1_500);
      expect(doc.values).toHaveLength(2);
      expect(parseDocSnap(doc.values[1]).data).toEqual({ n: 2 });
      expect(doc.errors).toHaveLength(0); // listener never errored
      unsub();
    } finally {
      sb?.close();
      await context.close();
      await serve.stop();
    }
  });

  test('4. peer handoff: standby claims a vacated slot, ops resume, fresh-tab-wins is quiet', async ({ browser }) => {
    const serve = await startSoakServe();
    const context = await newInstrumentedContext(browser);
    let sb: RemoteSandbox | null = null;
    try {
      // Studio first (standby), app second (winner).
      const { standbyTab, winnerTab } = await openTwoTabs(context, serve, {
        first: serve.info.uiUrl!,
        second: serve.info.url,
      });

      sb = await connectRemoteSandbox({ url: serve.info.url });
      await sb.channel.op({ method: 'setDoc', path: 'soak/handoff', data: { stage: 'before' }, actAs: { mode: 'admin' } });
      const doc = makeCollector();
      const unsub = sb.channel.subscribe(
        { target: { __ref: 'doc', path: 'soak/handoff' }, actAs: OBSERVER_LENS },
        doc.onSnap,
        doc.onError,
      );
      await waitFor('initial snapshot', () => doc.values.length >= 1);

      // Close the winning tab ENTIRELY. The standby tab's health poll
      // (2s + ≤50% jitter) must claim the vacant slot.
      const claimStarted = Date.now();
      await winnerTab.close();
      await waitFor(
        'standby tab claimed the slot (second hello)',
        async () => (await wsLog(standbyTab)).hellos >= 2,
        { timeoutMs: 10_000 },
      );
      await waitForPeer(serve.info.url, 10_000);
      const claimMs = Date.now() - claimStarted;

      // Ops resume against the new peer.
      await sb.rtdb.set('soak/afterHandoff', { ok: true });
      expect(await sb.rtdb.get('soak/afterHandoff')).toEqual({ ok: true });

      // Reopen a fresh tab: fresh-tab-wins must displace the current holder
      // once (no fight) and must not disturb the Node client.
      const fresh = await context.newPage();
      await fresh.goto(serve.info.url);
      await waitFor('fresh tab won the slot', async () => (await wsLog(fresh)).hellos >= 1, { timeoutMs: 20_000 });
      await waitFor('ex-standby replaced again (close 4001)', async () => {
        const log = await wsLog(standbyTab);
        return log.closes.filter((c) => c === 4001).length >= 2;
      });
      await waitForPeer(serve.info.url);
      await sleep(2_500); // quiet window after the churn

      // The Node client is undisturbed: ops work, the listener saw NOTHING
      // from two handoffs (the doc never changed), and no errors surfaced.
      expect(await sb.channel.op({ method: 'getDoc', path: 'soak/handoff', actAs: { mode: 'admin' } })).toBeTruthy();
      expect(
        doc.values,
        `handoffs re-fired the listener: ${JSON.stringify(doc.values.map(parseDocSnap))}`,
      ).toHaveLength(1);
      expect(doc.errors).toHaveLength(0);
      // Fresh tab helloed exactly once; no slot fighting after settle.
      expect((await wsLog(fresh)).hellos).toBe(1);
      expect((await wsLog(standbyTab)).hellos).toBe(2);

      test.info().annotations.push({ type: 'timing', description: `standby claimed slot in ${claimMs}ms` });
      unsub();
    } finally {
      sb?.close();
      await context.close();
      await serve.stop();
    }
  });

  test('5. first-run race: --no-open skips the wait by design; child fails fast then recovers; the gate holds when polled', async ({ browser }) => {
    // The opened-gating in src/cli/serve.ts: waitForSandboxPeer runs ONLY
    // when serve itself opened a tab (`opened`), and --json/--no-open force
    // opened=false — so a `-- <cmd>` child under --json is DOCUMENTED to
    // race: its first sandbox op fails fast with the "no browser tab is
    // connected … and retry" guidance, and a retry after a tab opens works.
    const remoteDistUrl = pathToFileURL(
      CLI_PATH.replace(/cli[\\/]index\.js$/, 'remote/index.js'),
    ).href;
    const childScript = `// first line of work is a sandbox op — the race under test
import { connectRemoteSandbox } from '${remoteDistUrl}';
const url = (process.env.PYRIC_SANDBOX ?? '').replace(/^remote:/, '');
try {
  const sb = await connectRemoteSandbox({ url });
  console.log('FIRST_OP_OK');
  sb.close();
} catch (err) {
  console.log('FIRST_OP_ERR:' + err.message);
}
const deadline = Date.now() + 25_000;
for (;;) {
  try {
    const sb = await connectRemoteSandbox({ url });
    await sb.rtdb.set('soak/firstRun', { ok: true });
    const v = await sb.rtdb.get('soak/firstRun');
    console.log('RETRY_OK:' + JSON.stringify(v));
    sb.close();
    break;
  } catch (err) {
    if (Date.now() > deadline) {
      console.log('RETRY_TIMEOUT:' + err.message);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}
`;
    const serve = await startSoakServe({
      extraFiles: { 'child.mjs': childScript },
      passthrough: ['node', 'child.mjs'],
    });
    const context = await newInstrumentedContext(browser);
    try {
      // The design promise, part 1: with --json/--no-open nothing was opened,
      // so the runner must NOT hold the child for a tab.
      expect(serve.stderr()).not.toContain('waiting for the browser tab');

      // The child raced and lost — fail-fast with the documented remediation.
      await waitFor(
        'child first-op fail-fast marker',
        () => serve.stderr().includes('FIRST_OP_ERR:'),
        { timeoutMs: 20_000 },
      );
      expect(serve.stderr()).toContain('no browser tab is connected');
      expect(serve.stderr()).not.toContain('FIRST_OP_OK');

      // Deliberate 2s delay, then Playwright opens the tab the guidance asks for.
      await sleep(2_000);
      const page = await context.newPage();
      await page.goto(serve.info.url);
      await waitFor('child recovered after the tab opened', () => serve.stderr().includes('RETRY_OK:'), {
        timeoutMs: 30_000,
      });
      expect(serve.stderr()).toContain('RETRY_OK:{"ok":true}');
      await page.close();
    } finally {
      await context.close();
      await serve.stop();
    }

    // Part 2 — the auto-open case, simulated: the SAME gate the opened path
    // runs (waitForSandboxPeer from dist) polled against a fresh serve while
    // Playwright plays the auto-opened tab arriving 2s later. The gate must
    // hold until the peer registers — a child spawned behind it would never
    // see the no-tab error.
    const { waitForSandboxPeer } = (await import(
      pathToFileURL(CLI_PATH.replace(/index\.js$/, 'dev-runner.js')).href
    )) as { waitForSandboxPeer: (url: string) => Promise<boolean> };
    const serve2 = await startSoakServe();
    const context2 = await newInstrumentedContext(browser);
    try {
      expect((await health(serve2.info.url))?.sandboxConnected).toBe(false);
      const gateStarted = Date.now();
      const gate = waitForSandboxPeer(serve2.info.url);
      await sleep(2_000);
      const page = await context2.newPage();
      await page.goto(serve2.info.url);
      expect(await gate).toBe(true);
      const heldMs = Date.now() - gateStarted;
      expect(heldMs).toBeGreaterThanOrEqual(1_900); // held until the tab actually arrived
      expect((await health(serve2.info.url))?.sandboxConnected).toBe(true);
    } finally {
      await context2.close();
      await serve2.stop();
    }
  });

  test('6. MCP over streamable HTTP works concurrently with the Node client, same sandbox state', async ({ browser }) => {
    const serve = await startSoakServe();
    const context = await newInstrumentedContext(browser);
    let sb: RemoteSandbox | null = null;
    try {
      expect(serve.info.mcpUrl, 'serve must expose the MCP endpoint (--bridge)').toBeTruthy();
      const page = await context.newPage();
      await page.goto(serve.info.url);
      await waitForPeer(serve.info.url);

      sb = await connectRemoteSandbox({ url: serve.info.url });
      await sb.channel.op({ method: 'setDoc', path: 'soak/mcp', data: { answer: 42 }, actAs: { mode: 'admin' } });

      const mcp = new McpHttpClient(serve.info.mcpUrl!);
      await mcp.initialize();
      const tools = await mcp.toolsList();
      expect(tools).toContain('firestore_get_document');
      expect(tools).toContain('firestore_list_documents');

      // Both callers concurrently against the one sandbox: the MCP tool call
      // must round-trip the doc the Node client wrote, WHILE a Node-side op
      // is in flight on the same bridge.
      const [mcpResult, nodeResult] = await Promise.all([
        mcp.toolCall('firestore_get_document', { path: 'soak/mcp' }),
        sb.channel.op({ method: 'getDoc', path: 'soak/mcp', actAs: { mode: 'admin' } }),
      ]);
      expect(mcpResult.ok, `MCP tool call failed: ${mcpResult.summary}`).toBe(true);
      const mcpData = mcpResult.data as { exists: boolean; data: Record<string, unknown> | null };
      expect(mcpData.exists).toBe(true);
      expect(mcpData.data).toEqual({ answer: 42 });
      expect(parseDocSnap(nodeResult).data).toEqual({ answer: 42 });

      // And the reverse direction: an MCP write is visible to the Node client.
      const write = await mcp.toolCall('firestore_update_document', {
        path: 'soak/mcp',
        data: { answer: 42, via: 'mcp' },
      });
      expect(write.ok, `MCP update failed: ${write.summary}`).toBe(true);
      const after = parseDocSnap(
        await sb.channel.op({ method: 'getDoc', path: 'soak/mcp', actAs: { mode: 'admin' } }),
      );
      expect(after.data).toEqual({ answer: 42, via: 'mcp' });
    } finally {
      sb?.close();
      await context.close();
      await serve.stop();
    }
  });

  test('7. admin-lens Firestore listener bypasses rules', async ({ browser }) => {
    // The worker pins `actAs: { mode: 'admin' }` on the subscription. The
    // listener must preserve that bypass for its initial read and later
    // re-evaluations, just as one-shot admin operations do.
    const serve = await startSoakServe();
    const context = await newInstrumentedContext(browser);
    let sb: RemoteSandbox | null = null;
    try {
      const page = await context.newPage();
      await page.goto(serve.info.url);
      await waitForPeer(serve.info.url);
      sb = await connectRemoteSandbox({ url: serve.info.url });
      // Admin OP bypasses the auth-gated rules — this succeeds.
      await sb.channel.op({ method: 'setDoc', path: 'soak/adminListen', data: { n: 0 }, actAs: { mode: 'admin' } });

      const doc = makeCollector();
      sb.channel.subscribe(
        { target: { __ref: 'doc', path: 'soak/adminListen' }, actAs: { mode: 'admin' } },
        doc.onSnap,
        doc.onError,
      );
      await waitFor('admin-lens listener settles', () => doc.values.length >= 1 || doc.errors.length >= 1, {
        timeoutMs: 10_000,
      });
      // What the docs promise (and what currently FAILS): an initial snapshot,
      // no permission-denied.
      expect(doc.errors.map((e) => e.message)).toEqual([]);
      expect(doc.values).toHaveLength(1);
    } finally {
      sb?.close();
      await context.close();
      await serve.stop();
    }
  });
});
