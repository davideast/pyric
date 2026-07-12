/**
 * Sandbox e2e — the capture demo driven against the pyric dev worker host.
 *
 * The mechanization groundwork for the messaging graduation criterion
 * (docs/conformance/cdd.md step 8): the demo page's flow — mint a token,
 * click both send buttons, watch the foreground log entry and the SW-path
 * delivery — runs end to end with ZERO Google. This drives the variant page
 * (`app-sandbox/main.ts`, imports resolved to the worker-backed pyric
 * messaging client instead of `firebase/messaging`); the owner's manual
 * demo sign-off on the UNCHANGED page remains a separate, human step.
 *
 * What is real here, per the capture rig's serve-only precedent:
 *   - the WORKER is the real `pyric dev` SharedWorker bundle, built by the
 *     same `bundleWorker` the serve CLI uses (serve/bundler.ts), fed a real
 *     init payload over /__pyric/init.json with `messaging: true` — the
 *     climb gate exercised exactly as `PYRIC_CLIMB=1 pyric dev` wires it;
 *   - the page reports its REAL visibility over the transport; the
 *     background case hides the page with the rig's cross-origin decoy;
 *   - both deliveries are asserted to come from the BROKER (sender id
 *     999999999999, resource names under projects/pyric-sandbox/), and the
 *     run fails if any page issues a request beyond localhost — no
 *     fcm.googleapis.com traffic can hide.
 *
 * Automation traps carried over from the capture rig:
 *   - Playwright pages NEVER occlude each other (each page is its own
 *     window/target; probed 2026-07-09: sibling bringToFront leaves
 *     visibilityState 'visible' in BOTH headed and headless). The rig's own
 *     answer — navigate the page away — would kill this page's worker port,
 *     so after bringing the decoy to front the driver waits briefly for a
 *     REAL hidden report (a human-driven run produces one) and then falls
 *     back to the page's documented `__forceVisibility('hidden')` hook. The
 *     run records which path happened; the real-browser visibility wiring is
 *     still exercised in the visible direction (the initial report), and the
 *     rule itself is pinned by the worker-host suite + broker conformance.
 *   - occlusion-disable args are stripped in headed mode, as in the rig.
 *
 * Run headless (default) or headed:
 *   bun run scripts/oracle/messaging-web/e2e-sandbox.ts
 *   PYRIC_MSG_E2E_HEADED=1 bun run scripts/oracle/messaging-web/e2e-sandbox.ts
 * Serve-only (a human and their own browser, no automation):
 *   PYRIC_MSG_E2E_SERVE_ONLY=1 bun run packages/conformance/src/capture/messaging-web/e2e-sandbox.ts
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The REAL pyric dev worker bundle path (imported from pyric-tools SOURCE so
// the freshly-edited worker host — messaging ops included — is what bundles).
import { bundleWorker } from '../../../../../packages/pyric-tools/src/serve/bundler.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');
const PORT = 4875;
const DECOY_PORT = 4876;
const ORIGIN = `http://localhost:${PORT}`;
const DECOY = `http://localhost:${DECOY_PORT}`;
const SERVE_ONLY = !!process.env.PYRIC_MSG_E2E_SERVE_ONLY;
const HEADED = !!process.env.PYRIC_MSG_E2E_HEADED;

// Oracle-pinned token shape facts (messaging-web-token-shape).
const TOKEN_LENGTH = 142;

// playwright is not hoisted to the root (bun isolated linker); resolve it
// from the packages that carry it — the capture rig's loader, verbatim.
async function loadChromium() {
  const candidates = [
    'playwright',
    join(REPO, 'packages/playground/node_modules/playwright/index.mjs'),
    join(REPO, 'packages/pyric-tools/node_modules/playwright/index.mjs'),
  ];
  for (const c of candidates) {
    try {
      const mod = await import(c.startsWith('/') ? pathToFileURL(c).href : c);
      return (mod.chromium ?? mod.default?.chromium) as typeof import('playwright').chromium;
    } catch {
      /* next */
    }
  }
  throw new Error('playwright not found; run bun install in packages/playground');
}

// ─── Build: the page bundle + the REAL pyric dev worker bundle ───────────
const built = await Bun.build({
  entrypoints: [join(HERE, 'app-sandbox/main.ts')],
  define: { __DECOY__: JSON.stringify(DECOY) },
  target: 'browser',
  format: 'esm',
});
if (!built.success) {
  console.error(built.logs.join('\n'));
  process.exit(1);
}
const pageJs = await built.outputs[0]!.text();

const workerOutDir = mkdtempSync(join(tmpdir(), 'pyric-msg-e2e-worker-'));
const workerFile = await bundleWorker({ outDir: workerOutDir, noCache: true });
const workerJs = readFileSync(workerFile, 'utf8');
const workerMap = existsSync(`${workerFile}.map`) ? readFileSync(`${workerFile}.map`, 'utf8') : null;
console.log(`worker bundle: ${workerFile} (${(workerJs.length / 1024 / 1024).toFixed(1)} MB)`);

// ─── The pyric dev-style init payload: messaging EXPLICITLY enabled ───────
// This is byte-shape what `PYRIC_CLIMB=1 pyric dev` serves (rules-less
// project): the worker's applyServeInit flips ctx.messagingEnabled from it.
const INIT_PAYLOAD = {
  rules: null,
  rulesHash: null,
  bridgeUrl: null,
  seed: null,
  persist: false,
  seedState: null,
  capture: false,
  messaging: true,
};

// ─── Capture state + servers (rig pattern) ────────────────────────────────
interface Capture { kind: string; data: Record<string, unknown>; at: number }
const captures: Capture[] = [];

const HTML = `<!doctype html><meta charset="utf-8"><title>pyric messaging sandbox e2e</title>
<style>body{font-family:system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
button{font-size:1rem;padding:.5rem 1rem;margin-right:.6rem;cursor:pointer}
#token{font-family:monospace;font-size:.7rem;word-break:break-all;color:#666}
#log{list-style:none;padding:0}#log li{border:1px solid #ddd;border-radius:4px;padding:.6rem .8rem;margin:.5rem 0}
#log pre{font-size:.72rem;overflow-x:auto;margin:.4rem 0 0}</style>
<body>
<h1>pyric messaging sandbox e2e</h1>
<p id="status">starting…</p>
<p>
  <button id="send-fg">Send to this page (foreground)</button>
  <button id="send-bg">Send in 4s (background — decoy tab hides this page)</button>
</p>
<p id="token"></p>
<ul id="log"></ul>
<script type="module" src="/main.js"></script>`;

Bun.serve({
  port: DECOY_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>decoy</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h2>Decoy tab (different origin)</h2><p>The sandbox page is now hidden; the broker routes the next delivery to the background handler. Switch back to see the log.</p>`,
      { headers: { 'content-type': 'text/html' } },
    ),
});

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/') return new Response(HTML, { headers: { 'content-type': 'text/html' } });
    if (pathname === '/main.js')
      return new Response(pageJs, { headers: { 'content-type': 'text/javascript' } });
    if (pathname === '/worker.js')
      return new Response(workerJs, { headers: { 'content-type': 'text/javascript' } });
    if (pathname === '/worker.js.map' && workerMap)
      return new Response(workerMap, { headers: { 'content-type': 'application/json' } });
    if (pathname === '/__pyric/init.json')
      return new Response(JSON.stringify(INIT_PAYLOAD), {
        headers: { 'content-type': 'application/json' },
      });
    if (pathname === '/__pyric/events')
      // Hot-reload SSE stub: stay open, send nothing (the worker retries a
      // closed stream in a loop otherwise).
      return new Response(new ReadableStream({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' },
      });
    if (pathname === '/capture' && req.method === 'POST') {
      const body = (await req.json()) as { kind: string; data: Record<string, unknown> };
      captures.push({ ...body, at: Date.now() });
      console.log(`  capture: ${body.kind}${body.data && 'state' in body.data ? ` (${JSON.stringify(body.data)})` : ''}`);
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
});

function tagOf(c: Capture): string | undefined {
  const payload = (c.data as { payload?: { data?: { tag?: string } } }).payload;
  return payload?.data?.tag;
}
function payloadOf(c: Capture): Record<string, unknown> {
  return (c.data as { payload: Record<string, unknown> }).payload;
}

async function waitFor(kind: string, timeoutMs: number, fromIdx = 0): Promise<Capture> {
  const start = Date.now();
  for (;;) {
    const hit = captures.slice(fromIdx).find((c) => c.kind === kind);
    if (hit) return hit;
    const err = captures.slice(fromIdx).find((c) => c.kind === 'error');
    if (err) throw new Error(`page error: ${JSON.stringify(err.data)}`);
    if (Date.now() - start > timeoutMs)
      throw new Error(`timeout waiting for ${kind}; got: ${captures.slice(fromIdx).map((c) => c.kind).join(', ')}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function waitTag(kind: string, tag: string, timeoutMs: number): Promise<Capture> {
  const start = Date.now();
  for (;;) {
    const hit = captures.find((c) => c.kind === kind && tagOf(c) === tag);
    if (hit) return hit;
    const err = captures.find((c) => c.kind === 'error');
    if (err) throw new Error(`page error: ${JSON.stringify(err.data)}`);
    if (Date.now() - start > timeoutMs)
      throw new Error(
        `timeout waiting for ${kind}#${tag}; got: ${captures.map((c) => `${c.kind}${tagOf(c) ? '#' + tagOf(c) : ''}`).join(', ')}`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ─── Serve-only mode: a human and their own browser (rig precedent) ───────
if (SERVE_ONLY) {
  console.log(`── SERVE-ONLY SANDBOX DEMO ──────────────────────────────`);
  console.log(`Open ${ORIGIN} in your normal browser. No permission prompt —`);
  console.log('there is no push plane; the sandbox broker delivers everything.');
  console.log('  foreground: message appears in the page log');
  console.log('  background: switch to any other tab within 4s; on return the');
  console.log('              log shows the onBackgroundMessage (SW-path) entry');
  console.log('Ctrl+C here when done.');
  await new Promise(() => {});
}

// ─── Drive the browser ─────────────────────────────────────────────────────
const chromium = await loadChromium();
console.log(`Serving sandbox demo at ${ORIGIN} (${HEADED ? 'headed' : 'headless'})…`);
const browser = await chromium.launch({
  headless: !HEADED,
  // Headed: strip Playwright's occlusion-disable args so a hidden window
  // reports visibilityState 'hidden' (the rig's trap, carried over).
  ...(HEADED
    ? {
        ignoreDefaultArgs: [
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling',
        ],
      }
    : {}),
});
const context = await browser.newContext();

// No-Google watchdog: every request from every page must stay on localhost.
const offOrigin: string[] = [];
function watch(page: import('playwright').Page): void {
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.protocol === 'data:' || url.protocol === 'about:') return;
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') offOrigin.push(req.url());
  });
}
context.on('page', watch);

const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`✓ ${name}`);
  else {
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failures.push(name);
  }
}

const page = await context.newPage();
await page.goto(ORIGIN);

// Token mint — the broker's captured shape class, over the transport.
const tokenCap = await waitFor('token', 20_000);
const token = (tokenCap.data as { token: string }).token;
check('token minted from the broker', token.length === TOKEN_LENGTH && token.includes(':'), `got ${token.length} chars`);
await waitFor('listening', 10_000);

// Token stability (rig scenario B, over the transport).
const tokenAgain = (await page.evaluate('window.__getTokenAgain()')) as string;
check('getToken stable across calls', tokenAgain === token);

// ── Foreground: click the button, the message lands in the page log ───────
await page.click('#send-fg');
const fg = await waitTag('onMessage', 'foreground', 15_000);
const fgPayload = payloadOf(fg) as {
  from?: string;
  messageId?: string;
  data?: Record<string, string>;
  notification?: { title?: string };
};
check('foreground delivered to onMessage', true);
check('foreground payload is the BROKER envelope (from = sandbox sender id)', fgPayload.from === '999999999999', String(fgPayload.from));
check('foreground messageId present', typeof fgPayload.messageId === 'string' && fgPayload.messageId.length > 0);
check('foreground data echoed exactly', fgPayload.data?.source === 'messaging-web-e2e' && fgPayload.data?.tag === 'foreground');
check('foreground notification delivered', fgPayload.notification?.title === 'oracle foreground');
const fgMeta = (fg.data as { meta?: { visibilityState?: string } }).meta;
check('page was visible at foreground delivery', fgMeta?.visibilityState === 'visible');
const fgAccepted = captures.find((c) => c.kind === 'send-accepted' && (c.data as { tag: string }).tag === 'foreground');
check(
  'send accepted with the broker resource name',
  /^projects\/pyric-sandbox\/messages\//.test(String((fgAccepted?.data as { name?: string })?.name)),
  String((fgAccepted?.data as { name?: string })?.name),
);
const fgLog = await page.locator('#log li').first().textContent();
check('foreground log entry rendered on the page', (fgLog ?? '').includes('onMessage'), String(fgLog));

// ── Background: hide the page (decoy tab), the SW-path handler fires ──────
const beforeBg = captures.length;
const popupPromise = page.waitForEvent('popup');
await page.click('#send-bg');
const popup = await popupPromise;
watch(popup);
await popup.bringToFront();

// Wait for a REAL hidden report; fall back to the documented automation hook
// (headless tab activation does not reliably fire visibilitychange).
let forcedHidden = false;
const hiddenDeadline = Date.now() + 2_500;
for (;;) {
  const hidden = captures
    .slice(beforeBg)
    .find((c) => c.kind === 'visibility' && (c.data as { state: string }).state === 'hidden');
  if (hidden) break;
  if (Date.now() > hiddenDeadline) {
    forcedHidden = true;
    await page.evaluate("window.__forceVisibility('hidden')");
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(`  page hidden via ${forcedHidden ? 'FORCED fallback (__forceVisibility)' : 'real visibilitychange'}`);

const bg = await waitTag('onBackgroundMessage', 'background', 20_000);
const bgPayload = payloadOf(bg) as {
  from?: string;
  messageId?: string;
  data?: Record<string, string>;
  notification?: { title?: string };
};
check('background delivered to the SW-path handler (onBackgroundMessage)', true);
check('background payload is the BROKER envelope (from = sandbox sender id)', bgPayload.from === '999999999999', String(bgPayload.from));
check('background data echoed exactly', bgPayload.data?.source === 'messaging-web-e2e' && bgPayload.data?.tag === 'background');
check(
  'background did NOT leak to onMessage',
  !captures.some((c) => c.kind === 'onMessage' && tagOf(c) === 'background'),
);
const bgAccepted = captures.find((c) => c.kind === 'send-accepted' && (c.data as { tag: string }).tag === 'background');
check(
  'background send accepted with the broker resource name',
  /^projects\/pyric-sandbox\/messages\//.test(String((bgAccepted?.data as { name?: string })?.name)),
);

// ── The no-Google proof ────────────────────────────────────────────────────
check('no request left localhost (no fcm.googleapis.com — nothing at all)', offOrigin.length === 0, offOrigin.join(', '));
check('specifically: zero fcm.googleapis.com requests', !offOrigin.some((u) => u.includes('fcm.googleapis.com')));

await browser.close();
server.stop(true);

if (failures.length > 0) {
  console.error(`\n✗ e2e failed: ${failures.length} assertion(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nAll sandbox e2e assertions passed — both demo routes delivered by the broker, no Google.');
process.exit(0);
