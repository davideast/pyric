/**
 * Web receive-plane capture harness — the browser-bound messaging oracle.
 *
 * Captures the CLIENT side of FCM against real production: token
 * registration, foreground onMessage payload shape, and background
 * onBackgroundMessage payload shape, as house-format observations pinned to
 * the installed firebase version (fbSdkVersion, like all client captures).
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
 *      file-writing path out of a browser.
 *   4. The driver sends real messages via firebase-admin (the provisioned
 *      service account): once with the page FOCUSED (routes to onMessage),
 *      once with a blank tab focused (routes to the SW's
 *      onBackgroundMessage).
 *   5. Structural facts (payload keys, format classes, echo fidelity) are
 *      written as observations; prod noise (token values, message ids,
 *      timestamps) is reduced to shape facts.
 *
 * Requires in env:
 *   PYRIC_MESSAGING_FIREBASE_CONFIG  web app config JSON of the SAME
 *                                    project as the VAPID key and SA
 *   PYRIC_MESSAGING_VAPID_KEY        Web Push certificate public key
 *   PYRIC_MESSAGING_SA_BASE64        send-capable service account
 *
 * Run (headed browser will open):
 *   bun run scripts/oracle/messaging-web/harness.ts
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { ServiceAccount } from 'firebase-admin/app';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

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
const OBS_DIR = join(HERE, '..', 'observations');
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

// ─── Build the app with config injected ─────────────────────────────────
const define = {
  __CONFIG__: JSON.stringify(webConfig),
  __VAPID__: JSON.stringify(vapidKey),
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

// ─── Send: foreground, then background ──────────────────────────────────
const send = (tag: string) => sendTo(token, tag);

if (process.env.PYRIC_MSG_DEMO) {
  console.log('\n── DEMO MODE ─────────────────────────────────────────');
  console.log('The browser is yours. Use the two buttons on the page:');
  console.log('  foreground: the message appears in the page log (no OS notification — that is the real foreground contract)');
  console.log('  background: switch windows or minimize within 4s; the service worker shows a real OS notification');
  console.log('Ctrl+C here when done. No observations are written in demo mode.');
  await new Promise(() => {});
}

await page.bringToFront();
const fgId = await send('foreground');
console.log(`  sent foreground: ${fgId}`);
const fg = await waitFor('onMessage', 45_000);

// Background routing keys on page VISIBILITY, not focus — and Playwright
// opens new pages as separate windows, so a "blank tab" leaves the capture
// page visible (verified empirically: the message routed to onMessage).
// Navigate the capture page itself away: the SW keeps controlling the
// scope with zero visible clients, the true background case.
await page.goto('about:blank');
const bgId = await send('background');
console.log(`  sent background: ${bgId}`);
const bg = await waitFor('onBackgroundMessage', 45_000);

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

function writeObservation(name: string, description: string, behavior: Record<string, unknown>): void {
  writeFileSync(
    join(OBS_DIR, `${name}.json`),
    JSON.stringify(
      {
        name,
        matrixRow: 'messaging (no rows yet; surface admitted born-unverified under the CDD map)',
        rowIds: [] as string[],
        description,
        observedAt: new Date().toISOString(),
        fbSdkVersion,
        projectId,
        behavior,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`✓ ${name}`);
}

writeObservation(
  'messaging-web-token-shape',
  'getToken(messaging, { vapidKey, serviceWorkerRegistration }) against production FCM: token format facts. Probe: real Chromium, localhost secure context, permission granted, real registration API.',
  {
    minted: true,
    length: token.length,
    colonSeparated: token.includes(':'),
    suffixAfterColonStartsWithAPA91b: token.split(':')[1]?.startsWith('APA91b') ?? false,
    urlSafe: /^[A-Za-z0-9_:-]+$/.test(token),
  },
);
writeObservation(
  'messaging-web-onmessage-foreground',
  'A notification+data message sent to a token while the page is FOCUSED is delivered to onMessage (not the SW). Payload structural facts; prod noise (ids, token) reduced to shape.',
  { deliveredTo: 'onMessage', ...payloadFacts(fg.data, 'foreground') },
);
writeObservation(
  'messaging-web-onbackgroundmessage',
  'The same message shape sent while the page is HIDDEN (another tab focused) is delivered to the service worker onBackgroundMessage handler instead. Payload structural facts.',
  { deliveredTo: 'onBackgroundMessage', ...payloadFacts(bg.data, 'background') },
);

console.log('\nDone. Register the three new observation exceptions before compat:validate.');
process.exit(0);
