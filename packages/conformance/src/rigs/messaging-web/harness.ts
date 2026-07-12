/**
 * Web receive-plane capture harness — the browser-bound messaging oracle.
 *
 * Captures the CLIENT side of FCM against real production as house-format
 * observations. Client-plane facts are pinned to the installed firebase
 * version (fbSdkVersion); the one cross-plane capture (deleteToken then a
 * server send to the dead token) additionally carries adminSdkVersion.
 *
 * Scenarios, run SEQUENTIALLY against ONE reused persistent profile (a
 * single mint of a single token drives all of them):
 *   messaging-web-token-shape            token format facts
 *   messaging-web-onmessage-foreground   focused page → onMessage
 *   messaging-web-token-stability        getToken twice → same token
 *   messaging-web-visibility-routing     visible-but-unfocused → onMessage;
 *                                        no visible client → onBackgroundMessage
 *   messaging-web-onbackgroundmessage    hidden page → SW payload facts
 *   messaging-web-data-only-background   data-only + hidden: does
 *                                        onBackgroundMessage fire, any auto-display?
 *   messaging-web-deletetoken-unregistered  deleteToken, send to old token →
 *                                        UNREGISTERED/404 envelope + no delivery
 *
 * How it works:
 *   1. Serves a real firebase/messaging app (app/main.ts + app/sw.ts,
 *      bundled with the project config and VAPID key injected) on
 *      localhost — a secure context, so SW + push work without TLS.
 *   2. Launches HEADED Chromium via Playwright with the notifications
 *      permission granted. Headed matters: real push delivery arrives from
 *      Google's push service over the browser's GCM channel, which
 *      headless contexts do not reliably connect.
 *   3. The page and SW report every event over POST /capture — the only
 *      file-writing path out of a browser. Every delivery carries a `tag`
 *      in message.data so the driver can wait on the RIGHT capture across
 *      many sends on one profile.
 *   4. The driver sends real messages via firebase-admin (the provisioned
 *      service account) and drives client SDK calls (getToken again,
 *      deleteToken) over page.evaluate against helpers the page exposes.
 *   5. Structural facts (payload keys, format classes, echo fidelity,
 *      visibility-at-delivery, error-envelope shape) are written as
 *      observations; prod noise (token values, message ids, timestamps) is
 *      reduced to shape facts.
 *
 * Automation traps (all load-bearing — do not "simplify" away):
 *   - caffeinate: every run re-execs itself under `caffeinate -is` (guard
 *     below) so display/idle/disk sleep cannot interrupt a multi-minute
 *     capture that depends on the live GCM channel.
 *   - Persistent profile, NOT an incognito context: Chrome disables web
 *     push in incognito, so launchPersistentContext is mandatory.
 *   - CDP push grant: Playwright's grantPermissions has no 'push'; the
 *     descriptor is granted over CDP before the app loads.
 *   - Occlusion flags: Playwright's default disable-occlusion args are
 *     stripped so a hidden window reports visibilityState 'hidden'.
 *   - The ONLY reliable "no visible client" under automation is navigating
 *     the capture page itself away (about:blank). A second window (even
 *     cross-origin) leaves the capture page VISIBLE — which is exactly why
 *     it is the driver for the visible-but-unfocused case, and why it
 *     CANNOT stand in for the background case.
 *   - deleteToken needs a live messaging instance, so scenario F navigates
 *     BACK to the origin (re-running the app; getToken returns the same
 *     stable token), deletes it, then sends to it.
 *
 * Requires in env:
 *   PYRIC_MESSAGING_FIREBASE_CONFIG  web app config JSON of the SAME
 *                                    project as the VAPID key and SA
 *   PYRIC_MESSAGING_VAPID_KEY        Web Push certificate public key
 *   PYRIC_MESSAGING_SA_BASE64        send-capable service account
 *
 * Run (headed browser will open; re-execs under caffeinate automatically):
 *   bun run packages/conformance/src/rigs/messaging-web/harness.ts
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { ServiceAccount } from 'firebase-admin/app';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');

// ─── caffeinate: wrap EVERY run so the machine cannot sleep mid-capture ───
// Real push delivery depends on an uninterrupted GCM channel; a display or
// idle sleep between a send and its delivery silently fails the capture.
// Re-exec self under `caffeinate -is` (idle + disk) once, on macOS.
if (process.platform === 'darwin' && !process.env.PYRIC_MSG_CAFFEINATED) {
  const r = spawnSync('caffeinate', ['-is', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, PYRIC_MSG_CAFFEINATED: '1' },
  });
  process.exit(r.status ?? 0);
}

// playwright is not hoisted to the root (bun isolated linker); resolve it
// from the packages that carry it.
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
const SERVE_ONLY = !!process.env.PYRIC_MSG_SERVE_ONLY;
const chromium = SERVE_ONLY ? (null as never) : await loadChromium();
// messaging-web-* observations belong to the 'messaging' surface.
const OBS_DIR = join(HERE, '..', '..', '..', 'observations', 'messaging');
const PORT = 4873;
const ORIGIN = `http://localhost:${PORT}`;

// ─── Env ────────────────────────────────────────────────────────────────
function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`✗ ${name} is not set.`);
    process.exit(1);
  }
  return v;
}
const webConfig = JSON.parse(need('PYRIC_MESSAGING_FIREBASE_CONFIG')) as Record<string, string>;
const vapidKey = need('PYRIC_MESSAGING_VAPID_KEY');
const sa = JSON.parse(Buffer.from(need('PYRIC_MESSAGING_SA_BASE64'), 'base64').toString('utf8')) as ServiceAccount & { project_id?: string };
const projectId = (sa.projectId ?? sa.project_id)!;
if (webConfig.projectId !== projectId) {
  console.error(`✗ Config mismatch: web config is for ${webConfig.projectId}, service account for ${projectId}. Token registration requires the same project.`);
  process.exit(1);
}
const fbSdkVersion = (
  JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('firebase/package.json')), 'utf8')) as { version: string }
).version;
// The deleteToken→UNREGISTERED capture spans both planes: a client deleteToken
// and a server send. The send transport is firebase-admin, so that one
// observation additionally records adminSdkVersion.
const adminSdkVersion = (
  JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('firebase-admin/package.json')), 'utf8')) as { version: string }
).version;

// ─── Build the app with config injected ─────────────────────────────────
const define = {
  __CONFIG__: JSON.stringify(webConfig),
  __VAPID__: JSON.stringify(vapidKey),
  // Per-run id: forces fresh SW bytes so its activate handler fires and
  // clears stale OS notifications before the data-only auto-display probe.
  __BUILD__: JSON.stringify(String(Date.now())),
};
const built = await Bun.build({
  entrypoints: [join(HERE, 'app/main.ts'), join(HERE, 'app/sw.ts')],
  define,
  target: 'browser',
  format: 'esm',
});
if (!built.success) {
  console.error(built.logs.join('\n'));
  process.exit(1);
}
const bundles = new Map<string, string>();
for (const out of built.outputs) {
  const name = out.path.endsWith('sw.js') ? '/firebase-messaging-sw.js' : '/main.js';
  bundles.set(name, await out.text());
}

// ─── Capture state + server ─────────────────────────────────────────────
interface Capture { kind: string; data: Record<string, unknown>; at: number }
const captures: Capture[] = [];
let mintedToken: string | null = null;

const admin = initializeApp({ credential: cert(sa) }, 'messaging-web-harness');
function sendTo(token: string, tag: string) {
  return getMessaging(admin).send({
    token,
    notification: { title: `oracle ${tag}`, body: `${tag} delivery capture` },
    data: { source: 'messaging-web-harness', tag, demo: '1' },
  });
}
// DATA-ONLY: no notification field. Drives the onBackgroundMessage /
// auto-display question for messages that carry no display payload.
function sendDataOnly(token: string, tag: string) {
  return getMessaging(admin).send({
    token,
    data: { source: 'messaging-web-harness', tag, demo: '1' },
  });
}
// Raw v1 messages:send, to capture the underlying google.rpc error envelope
// (firebase-admin re-wraps it as a FirebaseError; we want both shapes).
async function rawSend(token: string, tag: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const { access_token } = await admin.options.credential!.getAccessToken();
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: { token, notification: { title: `oracle ${tag}`, body: `${tag}` }, data: { source: 'messaging-web-harness', tag } },
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function sendDemo(tag: string, delayMs: number): Promise<void> {
  if (!mintedToken) return;
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const id = await sendTo(mintedToken, tag);
  console.log(`  demo send (${tag}): ${id}`);
}
const HTML = `<!doctype html><meta charset="utf-8"><title>pyric messaging oracle</title>
<style>body{font-family:system-ui;max-width:44rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
button{font-size:1rem;padding:.5rem 1rem;margin-right:.6rem;cursor:pointer}
#token{font-family:monospace;font-size:.7rem;word-break:break-all;color:#666}
#log{list-style:none;padding:0}#log li{border:1px solid #ddd;border-radius:4px;padding:.6rem .8rem;margin:.5rem 0}
#log pre{font-size:.72rem;overflow-x:auto;margin:.4rem 0 0}</style>
<body>
<h1>pyric messaging oracle</h1>
<p id="status">starting…</p>
<p>
  <button id="send-fg">Send to this page (foreground)</button>
  <button id="send-bg">Send in 4s (then minimize with cmd+M → OS notification)</button>
</p>
<p id="token"></p>
<ul id="log"></ul>
<script type="module" src="/main.js"></script>`;

// Cross-origin decoy for the demo's background button: a DIFFERENT port is
// a different origin, so this page is not a client of ours - switching to
// it genuinely hides the capture page without relying on OS occlusion.
const DECOY_PORT = 4874;
Bun.serve({
  port: DECOY_PORT,
  fetch: () =>
    new Response(
      `<!doctype html><meta charset="utf-8"><title>decoy</title><body style="font-family:system-ui;max-width:40rem;margin:4rem auto"><h2>Decoy tab (different origin)</h2><p>The capture page is now hidden. The OS notification should appear within a few seconds. Then switch back to the pyric tab to see the log.</p>`,
      { headers: { 'content-type': 'text/html' } },
    ),
});

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/') return new Response(HTML, { headers: { 'content-type': 'text/html' } });
    if (bundles.has(pathname))
      return new Response(bundles.get(pathname)!, {
        headers: { 'content-type': 'text/javascript', 'Service-Worker-Allowed': '/' },
      });
    if (pathname === '/capture' && req.method === 'POST') {
      const body = (await req.json()) as { kind: string; data: Record<string, unknown> };
      captures.push({ ...body, at: Date.now() });
      if (body.kind === 'token') mintedToken = (body.data as { token: string }).token;
      console.log(`  capture: ${body.kind}`);
      return new Response('ok');
    }
    if (pathname === '/send/foreground' && req.method === 'POST') {
      void sendDemo('foreground', 0);
      return new Response('ok');
    }
    if (pathname === '/send/background' && req.method === 'POST') {
      void sendDemo('background', 4000);
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },
});

async function waitFor(kind: string, timeoutMs: number): Promise<Capture> {
  const start = Date.now();
  for (;;) {
    const hit = captures.find((c) => c.kind === kind);
    if (hit) return hit;
    const err = captures.find((c) => c.kind === 'error');
    if (err) throw new Error(`page error: ${JSON.stringify(err.data)}`);
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${kind}; got: ${captures.map((c) => c.kind).join(', ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// After a reload the captures array still holds the previous load's events;
// wait only for captures that arrived at/after `fromIdx`.
async function waitFrom(kind: string, fromIdx: number, timeoutMs: number): Promise<Capture> {
  const start = Date.now();
  for (;;) {
    const hit = captures.slice(fromIdx).find((c) => c.kind === kind);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${kind} (from ${fromIdx}); got: ${captures.slice(fromIdx).map((c) => c.kind).join(', ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Delivery captures nest the FCM payload; the send tag lives at payload.data.tag.
function tagOf(c: Capture): string | undefined {
  const payload = (c.data as { payload?: { data?: { tag?: string } } }).payload;
  return payload?.data?.tag;
}
function payloadOf(c: Capture): Record<string, unknown> {
  return (c.data as { payload: Record<string, unknown> }).payload;
}
function metaOf(c: Capture): Record<string, unknown> {
  return ((c.data as { meta?: Record<string, unknown> }).meta) ?? {};
}

// Wait for a delivery of a SPECIFIC tag (many sends share one profile).
async function waitTag(kind: string, tag: string, timeoutMs: number): Promise<Capture> {
  const start = Date.now();
  for (;;) {
    const hit = captures.find((c) => c.kind === kind && tagOf(c) === tag);
    if (hit) return hit;
    const err = captures.find((c) => c.kind === 'error');
    if (err) throw new Error(`page error: ${JSON.stringify(err.data)}`);
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${kind}#${tag}; got kinds: ${captures.map((c) => `${c.kind}${tagOf(c) ? '#' + tagOf(c) : ''}`).join(', ')}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Assert NO delivery of `tag` arrives (to either route) within the window.
async function noDeliveryOf(tag: string, windowMs: number, fromIdx: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < windowMs) {
    const leaked = captures
      .slice(fromIdx)
      .find((c) => (c.kind === 'onMessage' || c.kind === 'onBackgroundMessage') && tagOf(c) === tag);
    if (leaked) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
  return true;
}

// ─── Serve-only mode: a human and their own browser, no automation ──────
if (SERVE_ONLY) {
  console.log(`── SERVE-ONLY DEMO ──────────────────────────────────────`);
  console.log(`Open ${ORIGIN} in your normal browser.`);
  console.log('Click Allow on the permission prompt. Then use the buttons:');
  console.log('  foreground: message appears in the page log, no OS notification');
  console.log('  background: switch to any other tab within 4s; the OS notification appears');
  console.log('Ctrl+C here when done.');
  await new Promise(() => {});
}

// ─── Drive the browser ──────────────────────────────────────────────────
console.log(`Serving capture app at ${ORIGIN} (headed browser opening)…`);
// Browser choice is empirical, controlled by PYRIC_MSG_CHANNEL:
//   chrome  - real Google Chrome (ships GCM API keys, but its automation
//             profile can deny PushManager.subscribe despite granted
//             notification permission)
//   bundled - Playwright Chromium (honors grantPermissions fully; GCM key
//             availability is the open question)
// Default: bundled first, since chrome denied push registration in testing.
const channel = process.env.PYRIC_MSG_CHANNEL ?? 'bundled';
// launchPersistentContext, NOT launch().newContext(): Playwright contexts
// are incognito, and Chrome disables web push in incognito — subscribe
// rejects with "permission denied" no matter what permissions are granted.
// A persistent profile is a normal, push-capable browsing context.
const userDataDir = join(process.env.TMPDIR ?? '/tmp', 'pyric-messaging-oracle-profile');
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  ...(channel === 'chrome' ? { channel: 'chrome' } : {}),
  // Playwright disables window-occlusion detection by default, so a
  // MINIMIZED window still reports visibilityState 'visible' and FCM keeps
  // routing foreground. Strip those flags so the browser behaves like a
  // user's browser.
  ignoreDefaultArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});
await context.grantPermissions(['notifications'], { origin: ORIGIN });
const page = context.pages()[0] ?? (await context.newPage());
const browser = { close: () => context.close() };
// Playwright's grantPermissions has no 'push': Chromium tracks push as its
// own permission, and PushManager.subscribe denies without it. Grant the
// Permissions-API descriptor directly over CDP before the app loads.
try {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Browser.setPermission', {
    permission: { name: 'push', userVisibleOnly: true },
    setting: 'granted',
    origin: ORIGIN,
  } as never);
  console.log('  push permission granted via CDP');
} catch (e) {
  console.log(`  CDP push grant failed (${String(e).slice(0, 80)}); continuing anyway`);
}
await page.goto(ORIGIN);

await waitFor('sw-registered', 15_000);
const perm = await waitFor('permission', 15_000);
if ((perm.data as { state?: string }).state !== 'granted') {
  console.error(`✗ Notification permission was ${JSON.stringify(perm.data)} — cannot mint a token.`);
  await browser.close();
  server.stop();
  process.exit(1);
}
const tokenCap = await waitFor('token', 30_000);
const token = (tokenCap.data as { token: string }).token;
console.log(`  token minted (${token.length} chars)`);
await waitFor('listening', 15_000);

if (process.env.PYRIC_MSG_DEMO) {
  console.log('\n── DEMO MODE ─────────────────────────────────────────');
  console.log('The browser is yours. Use the two buttons on the page:');
  console.log('  foreground: the message appears in the page log (no OS notification — that is the real foreground contract)');
  console.log('  background: switch windows or minimize within 4s; the service worker shows a real OS notification');
  console.log('Ctrl+C here when done. No observations are written in demo mode.');
  await new Promise(() => {});
}

// ─── Sequential scenarios on ONE reused profile/token ───────────────────
// Each scenario is isolated: a failure is recorded and the rest still run,
// so one un-automatable case never voids the others.
const results: Record<string, unknown> = {};
const failures: Record<string, string> = {};

// A genuine OS-level focus change: activate another app (Finder — it has no
// window covering a centered browser, so the capture page stays
// visibilityState 'visible' while losing document focus). This is the honest
// driver for visible-but-unfocused; Playwright's bringToFront() raises the
// tab but does NOT move macOS keyboard focus, so the page kept hasFocus.
function activateApp(name: string): void {
  spawnSync('osascript', ['-e', `tell application "${name}" to activate`], { stdio: 'ignore' });
}
async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  console.log(`── ${name} ──`);
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).stack ?? String(e);
    failures[name] = msg;
    console.error(`✗ scenario ${name}: ${msg.split('\n')[0]}`);
  }
}

// A — foreground (focused) → onMessage. The baseline receive contract.
await scenario('onmessage-foreground', async () => {
  await page.bringToFront();
  const id = await sendTo(token, 'foreground');
  console.log(`  sent foreground: ${id}`);
  results.fg = await waitTag('onMessage', 'foreground', 45_000);
});

// B — token stability: getToken twice on the same registration.
await scenario('token-stability', async () => {
  const t2 = (await page.evaluate('window.__getTokenAgain()')) as string;
  results.tokenStable = {
    firstMinted: token.length > 0,
    secondMinted: t2.length > 0,
    tokensEqual: t2 === token,
    sameLength: t2.length === token.length,
  };
  console.log(`  getToken again equal=${t2 === token}`);
});

// C — visible-but-unfocused → onMessage. Keep the capture page frontmost in
// the browser, then move OS focus to another app (Finder). The page stays
// visibilityState 'visible' but document.hasFocus() goes false — the genuine
// visible-but-unfocused case. Routing must still hit onMessage. The page
// records visibilityState+hasFocus AT delivery to prove the mechanism.
await scenario('visible-unfocused', async () => {
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 300));
  activateApp('Finder'); // OS-level focus change; browser window stays visible
  await new Promise((r) => setTimeout(r, 1000));
  const id = await sendTo(token, 'visible-unfocused');
  console.log(`  sent visible-unfocused: ${id}`);
  results.vuf = await waitTag('onMessage', 'visible-unfocused', 45_000);
  await page.bringToFront();
});

// D — DATA-ONLY + hidden, run FIRST among background sends so the SW's
// notification baseline is a clean zero (fresh worker cleared it on activate;
// no prior showNotification this run). Navigate the capture page away (the
// only reliable "no visible client" under automation). Does onBackgroundMessage
// fire, and does anything auto-display? The SW shows nothing and reports its
// live notification count — now attributable to this message alone.
await scenario('data-only-background', async () => {
  await page.goto('about:blank');
  const id = await sendDataOnly(token, 'data-only');
  console.log(`  sent data-only: ${id}`);
  results.dataOnly = await waitTag('onBackgroundMessage', 'data-only', 45_000);
});

// E — no visible client + notification message → onBackgroundMessage. Page is
// still at about:blank. The SW shows the OS notification (a registered handler
// disables SDK auto-display).
await scenario('onbackgroundmessage', async () => {
  const id = await sendTo(token, 'bg');
  console.log(`  sent bg: ${id}`);
  results.bg = await waitTag('onBackgroundMessage', 'bg', 45_000);
});

// F — deleteToken → UNREGISTERED. Navigate back (re-mint the same token),
// delete it, send to it, capture the send-side error envelope, and confirm
// nothing is delivered. Closes the send/receive loop. Runs LAST — it kills
// the token every other scenario relies on.
await scenario('deletetoken-unregistered', async () => {
  const mark = captures.length;
  await page.goto(ORIGIN);
  const tokCap = await waitFrom('token', mark, 30_000);
  await waitFrom('listening', mark, 15_000);
  const liveToken = (tokCap.data as { token: string }).token;
  const noLeakFrom = captures.length;
  const del = await page.evaluate('window.__deleteToken()');
  console.log(`  deleteToken resolved: ${JSON.stringify(del)}`);

  // firebase-admin send() at t0: may or may not throw depending on propagation.
  let adminThrow: { code?: string; httpStatus?: string; message?: string } | null = null;
  try {
    await sendTo(liveToken, 'deleted-token');
  } catch (e) {
    const fe = e as { code?: string; httpErrorCode?: { status?: string }; message?: string };
    adminThrow = { code: fe.code, httpStatus: fe.httpErrorCode?.status, message: fe.message };
  }

  // Raw send at t0, then POLL until the send plane flips to the
  // UNREGISTERED/404 envelope. Unregistration propagates ASYNC: right after
  // deleteToken the send plane can still return HTTP 200 (accepted) even
  // though the local push subscription is already gone, so delivery stops
  // immediately while the error surfaces only after propagation.
  const first = await rawSend(liveToken, 'deleted-token');
  console.log(`  first raw send after delete: ${first.status}`);
  let unreg: { status: number; body: Record<string, unknown> } | null = first.status >= 400 ? first : null;
  const deadline = Date.now() + 150_000;
  let polls = 0;
  while (!unreg && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8_000));
    polls++;
    const r = await rawSend(liveToken, 'deleted-token');
    if (r.status >= 400) {
      unreg = r;
      console.log(`  send plane returned ${r.status} after ${polls} extra poll(s)`);
    }
  }
  // Delivery must not reach the client on either route across the whole window.
  const leaked = captures
    .slice(noLeakFrom)
    .some((c) => (c.kind === 'onMessage' || c.kind === 'onBackgroundMessage') && tagOf(c) === 'deleted-token');

  results.deleteToken = {
    deleteResolvedTruthy: del === true || del === undefined,
    adminThrow,
    firstSendStatus: first.status,
    acceptedImmediatelyAfterDelete: first.status === 200,
    unregistered: unreg ? { status: unreg.status, error: (unreg.body as { error?: unknown }).error } : null,
    noDeliveryToClient: !leaked,
  };
});

await browser.close();
server.stop();
await deleteApp(admin);

// ─── Reduce to structural facts and write observations ──────────────────
function payloadFacts(payload: Record<string, unknown>, tag: string) {
  const notification = payload.notification as Record<string, unknown> | undefined;
  const data = payload.data as Record<string, string> | undefined;
  return {
    topLevelKeys: Object.keys(payload).sort(),
    notificationKeys: notification ? Object.keys(notification).sort() : null,
    notificationTitleDelivered: notification?.title === `oracle ${tag}`,
    dataKeys: data ? Object.keys(data).sort() : null,
    dataEchoedExactly: data?.source === 'messaging-web-harness' && data?.tag === tag,
    fromEqualsSenderId: payload.from === webConfig.messagingSenderId,
    messageIdPresent: typeof payload.messageId === 'string' && (payload.messageId as string).length > 0,
  };
}

// The messaging surface has been admitted under CDD: each capture cites the
// born-unverified `messaging#*` receive-plane rows it evidences (see
// scripts/compat/registry/messaging.ts) via `rowIds`. Citation is not replay —
// the rows stay `unverified` until the conformance suite replays them.
function writeObservation(
  name: string,
  rowIds: string[],
  description: string,
  behavior: Record<string, unknown>,
  versions: Record<string, string> = { fbSdkVersion },
): void {
  writeFileSync(
    join(OBS_DIR, `${name}.json`),
    JSON.stringify(
      {
        name,
        matrixRow: rowIds.join(', '),
        rowIds,
        description: `${description} Cited by ${rowIds.join(', ')} (surface climbing under CDD; cited, not yet replayed).`,
        observedAt: new Date().toISOString(),
        ...versions,
        projectId,
        behavior,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`✓ ${name}`);
}

// token-shape — always available once a token minted.
writeObservation(
  'messaging-web-token-shape',
  ['messaging#2'],
  `getToken(messaging, { vapidKey, serviceWorkerRegistration }) against production FCM: token format facts. Probe: real Chromium, localhost secure context, permission granted, real registration API.`,
  {
    minted: true,
    length: token.length,
    colonSeparated: token.includes(':'),
    suffixAfterColonStartsWithAPA91b: token.split(':')[1]?.startsWith('APA91b') ?? false,
    urlSafe: /^[A-Za-z0-9_:-]+$/.test(token),
  },
);

if (results.fg) {
  writeObservation(
    'messaging-web-onmessage-foreground',
    ['messaging#4', 'messaging#8', 'messaging#9'],
    `A notification+data message sent to a token while the page is FOCUSED is delivered to onMessage (not the SW). Payload structural facts; prod noise (ids, token) reduced to shape.`,
    { deliveredTo: 'onMessage', ...payloadFacts(payloadOf(results.fg as Capture), 'foreground') },
  );
}

if (results.tokenStable) {
  writeObservation(
    'messaging-web-token-stability',
    ['messaging#2'],
    `getToken(messaging, { vapidKey, serviceWorkerRegistration }) called a second time on the SAME service-worker registration returns the SAME token — no per-call rotation. Token value is prod noise; only the equality/shape facts are kept.`,
    results.tokenStable as Record<string, unknown>,
  );
}

if (results.vuf && results.bg) {
  const vufMeta = metaOf(results.vuf as Capture);
  writeObservation(
    'messaging-web-visibility-routing',
    ['messaging#4', 'messaging#14'],
    `FCM receive routing keys on page VISIBILITY, not focus: the firebase/messaging service worker decides foreground vs background solely by whether a window client reports visibilityState 'visible' (it never inspects focus). A page that is visibilityState 'visible' receives onMessage; a page with NO visible client (navigated away) routes to the service-worker onBackgroundMessage instead — both captured here. AUTOMATION LIMITATION (pinned, not forced): the visible-but-UNFOCUSED half could not be demonstrated — under Playwright/CDP-driven Chromium the page reports document.hasFocus()===true even after a real OS app-activation (osascript 'Finder' activate; app-control is itself gated by macOS Automation permissions). Because routing does not depend on focus, this does not weaken the contract, only the empirical focus=false sample.`,
    {
      routesOnVisibilityNotFocus: true,
      visibleClient: {
        deliveredTo: 'onMessage',
        visibilityStateAtDelivery: vufMeta.visibilityState,
        pageHadFocusAtDelivery: vufMeta.hasFocus,
        unfocusedSampleForcedUnderAutomation: false,
      },
      noVisibleClient: { deliveredTo: 'onBackgroundMessage' },
    },
  );
}

if (results.bg) {
  writeObservation(
    'messaging-web-onbackgroundmessage',
    ['messaging#8', 'messaging#14'],
    `A notification+data message sent while the page has NO visible client is delivered to the service worker onBackgroundMessage handler instead of onMessage. Payload structural facts.`,
    { deliveredTo: 'onBackgroundMessage', ...payloadFacts(payloadOf(results.bg as Capture), 'bg') },
  );
}

if (results.dataOnly) {
  const cap = results.dataOnly as Capture;
  const payload = payloadOf(cap);
  const meta = metaOf(cap);
  writeObservation(
    'messaging-web-data-only-background',
    ['messaging#14'],
    `A DATA-ONLY message (no notification field) sent while the page has no visible client: onBackgroundMessage FIRES, delivering a payload with data/from/messageId and NO notification key. Auto-display probe: this is the FIRST background send of the run against a freshly-activated worker (its activate handler cleared all notifications), and the handler displays nothing, so registration.getNotifications() afterwards is attributable to this message alone — value pinned as notificationsAfterHandler. NOTE: Chrome's own userVisibleOnly "site updated in the background" fallback is a browser-level notification and may or may not surface in getNotifications(); the pinned count is the honest, directly-observed number.`,
    {
      onBackgroundMessageFired: true,
      topLevelKeys: Object.keys(payload).sort(),
      hasNotificationKey: 'notification' in payload,
      dataKeys: payload.data ? Object.keys(payload.data as object).sort() : null,
      dataEchoedExactly:
        (payload.data as Record<string, string> | undefined)?.source === 'messaging-web-harness' &&
        (payload.data as Record<string, string> | undefined)?.tag === 'data-only',
      fromEqualsSenderId: payload.from === webConfig.messagingSenderId,
      messageIdPresent: typeof payload.messageId === 'string' && (payload.messageId as string).length > 0,
      notificationsAfterHandler: meta.notificationsAfterHandler,
    },
  );
}

if (results.deleteToken) {
  const d = results.deleteToken as {
    deleteResolvedTruthy: boolean;
    adminThrow: { code?: string; httpStatus?: string; message?: string } | null;
    firstSendStatus: number;
    acceptedImmediatelyAfterDelete: boolean;
    unregistered: { status: number; error?: Record<string, unknown> } | null;
    noDeliveryToClient: boolean;
  };
  const err = d.unregistered?.error ?? {};
  const details = (err.details as Array<Record<string, unknown>> | undefined) ?? [];
  const fcmDetail = details.find((x) => String(x['@type']).includes('FcmError'));
  writeObservation(
    'messaging-web-deletetoken-unregistered',
    ['messaging#3'],
    `deleteToken(messaging) then a server send to the now-deleted token. STABLE facts (pinned): the v1 messages:send plane eventually returns the UNREGISTERED/404-class google.rpc envelope (HTTP 404, status NOT_FOUND, details carry google.firebase.fcm.v1.FcmError with errorCode UNREGISTERED); firebase-admin send() re-wraps that as errorCode messaging/registration-token-not-registered; and NO delivery reaches the client on either route. Closes the send/receive loop. TIMING NUANCE (observed, NOT pinned — environment-dependent): unregistration propagates asynchronously; across runs the FIRST send after deleteToken returned 200 (accepted) on one run and 404 on another, while delivery had already stopped both times (the local push subscription is gone the instant deleteToken resolves). Cross-plane: client deleteToken (fbSdkVersion) + admin send (adminSdkVersion). Token value is prod noise, dropped.`,
    {
      deleteTokenResolvedTruthy: d.deleteResolvedTruthy,
      sendPlaneEventuallyUnregistered: d.unregistered !== null,
      unregisteredHttpStatus: d.unregistered?.status ?? null,
      unregisteredErrorStatus: err.status ?? null,
      unregisteredErrorCodeTop: err.code ?? null,
      unregisteredMessagePresent: typeof err.message === 'string' && (err.message as string).length > 0,
      unregisteredDetailTypes: details.map((x) => x['@type']),
      fcmErrorCode: fcmDetail?.errorCode ?? null,
      adminSendThrows: d.adminThrow !== null,
      adminThrowCode: d.adminThrow?.code ?? null,
      noDeliveryToClient: d.noDeliveryToClient,
    },
    { fbSdkVersion, adminSdkVersion },
  );
}

if (Object.keys(failures).length) {
  console.log('\n── scenario failures ──');
  for (const [k, v] of Object.entries(failures)) console.log(`✗ ${k}: ${v.split('\n')[0]}`);
}

console.log('\nDone. Register the new messaging-web observation exceptions before compat:validate.');
process.exit(0);
