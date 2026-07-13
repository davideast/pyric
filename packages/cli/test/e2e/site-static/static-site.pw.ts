import { test, expect, type Page } from '@playwright/test';

/**
 * Soak-style smoke check for the composed static site (`dist/site/`, built by
 * `scripts/build-site.sh`) served by a PLAIN static file server (see
 * `playwright.config.ts` — python3's `http.server`, no `pyric dev` behind it).
 *
 * Verifies the spike's core claim: everything degrades cleanly with ZERO
 * server routes behind the site.
 */

/** Every request URL seen on the page, collected via CDP-level request
 *  interception (not just fetch/XHR — also covers EventSource, which Chromium
 *  surfaces as a normal network request). */
function trackRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  return urls;
}

test('Studio loads at / with no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  const res = await page.goto('/');
  expect(res?.ok()).toBeTruthy();
  await expect(page).toHaveTitle(/./); // some non-empty title rendered
  // Give the app a beat to finish its async init (env resolve, worker connect).
  await page.waitForTimeout(1000);
  expect(errors, `uncaught page errors: ${errors.join('\n')}`).toEqual([]);
});

test('the SharedWorker bundle boots from /__pyric/sdk/worker.js', async ({ page }) => {
  // NOTE: requests issued from INSIDE the SharedWorker's own execution
  // context (fetch, EventSource) mostly surface through `page.on('request')`
  // in Chromium/Playwright, but `page.on('response')` is unreliable for them
  // (observed empirically — the worker's own fetches never fired a 'response'
  // event here even though the static server's access log shows a 200). Use
  // 'request' + a follow-up same-URL fetch from the page to confirm the
  // status, rather than relying on 'response' events for worker traffic.
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  await page.goto('/');
  await page.waitForTimeout(1500);
  const hit = urls.find((u) => u.includes('/__pyric/sdk/worker.js'));
  expect(hit, `expected a request for /__pyric/sdk/worker.js, saw:\n${urls.join('\n')}`).toBeTruthy();

  const status = await page.evaluate(async (url) => (await fetch(url)).status, hit);
  expect(status).toBe(200);
});

test('no requests to /__pyric/state|projects|workspace|capture are attempted', async ({ page }) => {
  const urls = trackRequests(page);
  await page.goto('/');
  await page.waitForTimeout(2000);

  const banned = /\/__pyric\/(state|projects|workspace|capture)(\?|$|\/)/;
  const hits = urls.filter((u) => banned.test(u));
  expect(hits, `unexpected requests to server-only routes:\n${hits.join('\n')}`).toEqual([]);
});

// Injected verbatim into the page via `page.evaluate` (a separate JS realm —
// no Node-side closures cross that boundary), so every worker-RPC test below
// repeats this small helper inline: post one `{t:'op', ...}` message and
// resolve with the matching `res` reply.
const WORKER_OP_HELPER = `
  function workerOp(worker, msg) {
    worker.port.start();
    return new Promise((resolve) => {
      const handler = (ev) => {
        const data = ev.data;
        if (data.t === 'res' && data.id === msg.id) {
          worker.port.removeEventListener('message', handler);
          resolve({ ok: !!data.ok, value: data.value, error: data.error });
        }
      };
      worker.port.addEventListener('message', handler);
      worker.port.postMessage(msg);
    });
  }
`;

test('a Firestore write via the worker port is visible to a second, independent connection (multi-tab)', async ({
  page,
}) => {
  // Drives the worker over the SAME wire protocol Studio's own live plane
  // (`@pyric/cli/serve/worker` client) uses — `admin.setDocument` /
  // `admin.getDocument` are simple ack/value RPCs, so this exercises the real
  // "write is visible through the worker port" path without reaching into
  // Studio's shell/UI internals (out of scope for this change): open TWO
  // independent `SharedWorker` connections (simulating two tabs) and confirm
  // a write on one is immediately visible on the other — the multi-tab
  // consistency the SharedWorker architecture exists for.
  await page.goto('/');
  await page.waitForTimeout(1000);

  const marker = `e2e-${Date.now()}`;
  const result = await page.evaluate(
    async ({ marker, helper }) => {
      // eslint-disable-next-line no-new-func
      const workerOp = new Function(`${helper}; return workerOp;`)() as (
        worker: SharedWorker,
        msg: Record<string, unknown>,
      ) => Promise<{ ok: boolean; value?: unknown }>;
      const workerA = new SharedWorker('/__pyric/sdk/worker.js', { name: 'pyric-shared-worker' });
      const write = await workerOp(workerA, {
        t: 'op',
        id: 'w1',
        method: 'admin.setDocument',
        path: 'notes/e2e-check',
        data: { marker },
      });
      const workerB = new SharedWorker('/__pyric/sdk/worker.js', { name: 'pyric-shared-worker' });
      const read = await workerOp(workerB, { t: 'op', id: 'r1', method: 'admin.getDocument', path: 'notes/e2e-check' });
      return { write, read };
    },
    { marker, helper: WORKER_OP_HELPER },
  );

  expect(result.write.ok).toBe(true);
  expect(result.read.ok).toBe(true);
  expect((result.read.value as { marker?: string } | null)?.marker).toBe(marker);
});

test(
  'a write survives a full page reload (IndexedDB durability through SharedWorker teardown)',
  async ({ page }) => {
    // Closed by main's persistence work (durable acked writes in #62,
    // then the RTDB/event-history durability stack): an acked write now
    // survives a full reload of the composed static site, so this
    // asserts it for real. IDB is the only durable tier here
    // (init.json ships persist: false).
    await page.goto('/');
    await page.waitForTimeout(1000);

    const marker = `e2e-${Date.now()}`;
    await page.evaluate(
      async ({ marker, helper }) => {
        // eslint-disable-next-line no-new-func
        const workerOp = new Function(`${helper}; return workerOp;`)() as (
          worker: SharedWorker,
          msg: Record<string, unknown>,
        ) => Promise<{ ok: boolean; value?: unknown }>;
        const worker = new SharedWorker('/__pyric/sdk/worker.js', { name: 'pyric-shared-worker' });
        await workerOp(worker, {
          t: 'op',
          id: 'w1',
          method: 'admin.setDocument',
          path: 'notes/reload-check',
          data: { marker },
        });
      },
      { marker, helper: WORKER_OP_HELPER },
    );

    await page.reload();
    await page.waitForTimeout(1500);

    const read = await page.evaluate(
      async ({ helper }) => {
        // eslint-disable-next-line no-new-func
        const workerOp = new Function(`${helper}; return workerOp;`)() as (
          worker: SharedWorker,
          msg: Record<string, unknown>,
        ) => Promise<{ ok: boolean; value?: unknown }>;
        const worker = new SharedWorker('/__pyric/sdk/worker.js', { name: 'pyric-shared-worker' });
        return await workerOp(worker, { t: 'op', id: 'r1', method: 'admin.getDocument', path: 'notes/reload-check' });
      },
      { helper: WORKER_OP_HELPER },
    );

    expect((read.value as { marker?: string } | null)?.marker).toBe(marker);
  },
);

test('the curated demo seed (__pyric/init.json) is applied on first worker boot', async ({ page }) => {
  await page.goto('/');
  await page.waitForTimeout(1000);

  const seeded = await page.evaluate(async () => {
    const worker = new SharedWorker('/__pyric/sdk/worker.js', { name: 'pyric-shared-worker' });
    worker.port.start();
    const res = await new Promise<{ ok: boolean; value?: Record<string, unknown> | null }>((resolve) => {
      worker.port.onmessage = (ev) => {
        const msg = ev.data as { t: string; id: string; ok?: boolean; value?: unknown };
        if (msg.t === 'res' && msg.id === 'e2e-seed-check') {
          resolve({ ok: !!msg.ok, value: msg.value as Record<string, unknown> | null });
        }
      };
      worker.port.postMessage({ t: 'op', id: 'e2e-seed-check', method: 'admin.getDocument', path: 'notes/welcome' });
    });
    return res.ok ? res.value : null;
  });

  expect(seeded).toBeTruthy();
  expect(seeded?.title).toBe('Welcome to Pyric Studio');
});

test('Auth rows align selection controls and distinguish never-signed-in users', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Auth', exact: true }).click();

  const table = page.getByRole('table', { name: 'Authentication users' });
  await expect(table).toBeVisible();
  const signal = await table.evaluate((root) => {
    const rows = Array.from(root.querySelectorAll('[role="row"]'));
    const checkboxCenters = rows.map((row) => {
      const checkbox = row.querySelector('input[type="checkbox"]');
      if (!(checkbox instanceof HTMLInputElement)) throw new Error('selection checkbox missing');
      const rect = checkbox.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    const signedIn = rows.slice(1).map(
      (row) => row.querySelector('[data-pyric-user-cell="signed-in"]')?.textContent?.trim(),
    );
    return { checkboxCenters, signedIn };
  });

  expect(new Set(signal.checkboxCenters).size).toBe(1);
  expect(signal.signedIn).toEqual(['never', 'never']);
});

test('DIAGNOSTIC: full request log for /__pyric/* on first load (not an assertion — informational)', async ({
  page,
}) => {
  const pyricRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/__pyric/')) pyricRequests.push(req.url());
  });
  await page.goto('/');
  await page.waitForTimeout(2500);
  // eslint-disable-next-line no-console
  console.log('[diagnostic] /__pyric/* requests on first load:\n' + pyricRequests.join('\n'));
  // No assertion — this test exists to surface the FULL request list in the
  // Playwright report for manual/report-writing inspection (e.g. whether the
  // worker's hot-reload EventSource opens a /__pyric/events connection even
  // with no `pyric dev` behind the site).
});
