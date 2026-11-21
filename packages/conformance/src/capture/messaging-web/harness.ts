/**
 * Web receive-plane capture harness - the browser-bound messaging oracle.
 *
 * Captures the CLIENT side of FCM against real production as house-format
 * observations. Client-plane facts are pinned to the installed firebase
 * version (fbSdkVersion); cross-plane captures (multi-device fan-out,
 * token rotation, deleteToken -> server UNREGISTERED) additionally carry
 * adminSdkVersion.
 *
 * Scenarios (filterable via `--only <s1,s2>`):
 *   messaging-web-token-shape               token format facts
 *   messaging-web-onmessage-foreground      focused page -> onMessage
 *   messaging-web-token-stability           getToken twice -> same token
 *   messaging-web-visibility-routing        visible-but-unfocused -> onMessage;
 *                                           no visible client -> onBackgroundMessage
 *   messaging-web-onbackgroundmessage       hidden page -> SW payload facts
 *   messaging-web-data-only-background      data-only + hidden: onBackgroundMessage
 *   messaging-web-multi-device-fanout       two persistent profiles -> per-token vs topic/multicast fan-out
 *   messaging-web-token-rotation            PushSubscription rotation -> new token + prior UNREGISTERED
 *   messaging-web-deletetoken-unregistered  deleteToken, send to old token -> UNREGISTERED/404 + silence
 *
 * Requires in env:
 *   PYRIC_MESSAGING_FIREBASE_CONFIG, PYRIC_MESSAGING_VAPID_KEY, and the send
 *   credential (PYRIC_MESSAGING_PROJECT_ID / PYRIC_ORACLE_PROJECT_ID with ADC,
 *   or PYRIC_MESSAGING_SA_BASE64).
 *
 * Run:
 *   bun run packages/conformance/src/capture/messaging-web/harness.ts --write
 *   bun run packages/conformance/src/capture/messaging-web/harness.ts --write --only multi-device-fanout,token-rotation
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { requireCaptureMode } from '../../capture-mode-guard.ts';
import {
  loadMessagingServiceAccount,
  messagingAccessToken,
  messagingSendEndpoint,
} from '../../messaging-credential.ts';
import { oracleAppOptions } from '../../oracle-credential.ts';
import { resolvedAdminVersion, resolvedFirebaseVersion } from '../../package-version.ts';
import {
  runMultiDeviceFanoutScenario,
  runTokenRotationScenario,
} from './lifecycle-scenarios.ts';
import { messagingWebProjectProblems } from './project-checks.ts';
import {
  MESSAGING_WEB_SCENARIO_NAMES,
  parseSelectedMessagingWebScenarios,
  writeMessagingWebObservations,
  type MessagingWebCaptureEvent,
  type MessagingWebRawResults,
  type MessagingWebScenarioName,
} from './write-observations.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');
const rawArgs = process.argv.slice(2);
const selectedScenarios = parseSelectedMessagingWebScenarios(rawArgs);
const isFullRun = selectedScenarios.size === MESSAGING_WEB_SCENARIO_NAMES.length;

const SERVE_ONLY = Boolean(process.env.PYRIC_MSG_SERVE_ONLY);
if (!SERVE_ONLY) {
  requireCaptureMode({
    label: 'messaging-web',
    scriptPath: 'packages/conformance/src/capture/messaging-web/harness.ts',
    argv: rawArgs,
    summary: `would run ${selectedScenarios.size} browser web-push messaging receive-plane scenario(s) (${[...selectedScenarios].join(', ')}).`,
    missingCredentials: () => {
      if (!process.env.PYRIC_MESSAGING_FIREBASE_CONFIG) return 'PYRIC_MESSAGING_FIREBASE_CONFIG';
      if (!process.env.PYRIC_MESSAGING_VAPID_KEY) return 'PYRIC_MESSAGING_VAPID_KEY';
      return null;
    },
  });
}

if (process.platform === 'darwin' && !process.env.PYRIC_MSG_CAFFEINATED) {
  const r = spawnSync('caffeinate', ['-is', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, PYRIC_MSG_CAFFEINATED: '1' },
  });
  process.exit(r.status ?? 0);
}

async function loadChromium() {
  const candidates = [
    '@playwright/test',
    join(REPO, 'packages/playground/node_modules/playwright/index.mjs'),
    join(REPO, 'packages/cli/node_modules/playwright/index.mjs'),
  ];
  for (const c of candidates) {
    try {
      const targetUrl = c.startsWith('/') ? pathToFileURL(c).href : c;
      const mod = await import(targetUrl);
      return (mod.chromium ?? mod.default?.chromium) as typeof import('@playwright/test').chromium;
    } catch {
      // Try next candidate.
    }
  }
  throw new Error('playwright not found; run bun install in packages/playground');
}

let chromium: Awaited<ReturnType<typeof loadChromium>> = null as never;
if (!SERVE_ONLY) {
  chromium = await loadChromium();
}

const OBS_DIR = join(HERE, '..', '..', '..', 'observations', 'messaging');
const PORT = 4873;
const ORIGIN = `http://localhost:${PORT}`;

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const webConfig = JSON.parse(need('PYRIC_MESSAGING_FIREBASE_CONFIG')) as Record<string, string>;
const vapidKey = need('PYRIC_MESSAGING_VAPID_KEY');
const sa = await loadMessagingServiceAccount().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`credential error: ${detail}`);
  process.exit(1);
});
const projectId = sa.project_id;
const projectProblems = messagingWebProjectProblems(webConfig, vapidKey, projectId);
if (projectProblems.length > 0) {
  for (const problem of projectProblems) console.error(`project check failed: ${problem}`);
  process.exit(1);
}
const fbSdkVersion = resolvedFirebaseVersion();
const adminSdkVersion = resolvedAdminVersion();

const define = {
  __CONFIG__: JSON.stringify(webConfig),
  __VAPID__: JSON.stringify(vapidKey),
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
  const bundleName = out.path.endsWith('sw.js') ? '/firebase-messaging-sw.js' : '/main.js';
  bundles.set(bundleName, await out.text());
}

const captures: MessagingWebCaptureEvent[] = [];
let mintedToken: string | null = null;

const admin = initializeApp(oracleAppOptions(sa), 'messaging-web-harness');
function sendTo(token: string, tag: string): Promise<string> {
  return getMessaging(admin).send({
    token,
    notification: { title: `oracle ${tag}`, body: `${tag} delivery capture` },
    data: { source: 'messaging-web-harness', tag, demo: '1' },
  });
}
function sendDataOnly(token: string, tag: string): Promise<string> {
  return getMessaging(admin).send({
    token,
    data: { source: 'messaging-web-harness', tag, demo: '1' },
  });
}
async function rawSend(
  token: string,
  tag: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const access_token = await messagingAccessToken(sa);
  const res = await fetch(messagingSendEndpoint(sa), {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token,
        notification: { title: `oracle ${tag}`, body: tag },
        data: { source: 'messaging-web-harness', tag },
      },
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
<p id="status">starting...</p>
<p>
  <button id="send-fg">Send to this page (foreground)</button>
  <button id="send-bg">Send in 4s (background)</button>
</p>
<p id="token"></p>
<ul id="log"></ul>
<script type="module" src="/main.js"></script>`;

const DECOY_PORT = 4874;
Bun.serve({
  port: DECOY_PORT,
  fetch: () =>
    new Response(
      '<!doctype html><meta charset="utf-8"><title>decoy</title><body><h2>Decoy tab (different origin)</h2>',
      { headers: { 'content-type': 'text/html' } },
    ),
});

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === '/') return new Response(HTML, { headers: { 'content-type': 'text/html' } });
    if (bundles.has(pathname)) {
      return new Response(bundles.get(pathname)!, {
        headers: { 'content-type': 'text/javascript', 'Service-Worker-Allowed': '/' },
      });
    }
    if (pathname === '/capture' && req.method === 'POST') {
      const body = (await req.json()) as {
        kind: string;
        data: Record<string, unknown>;
        device?: string;
      };
      const event: MessagingWebCaptureEvent = {
        kind: body.kind,
        data: body.data,
        at: Date.now(),
      };
      if (typeof body.device === 'string' && body.device !== '') {
        event.device = body.device;
      }
      captures.push(event);
      if (body.kind === 'token' && event.device === undefined) {
        mintedToken = (body.data as { token: string }).token;
      }
      console.log(`  capture: ${body.kind}${event.device ? ' (' + event.device + ')' : ''}`);
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

function isPrimaryEvent(c: MessagingWebCaptureEvent): boolean {
  return c.device === undefined;
}

function tagOf(c: MessagingWebCaptureEvent): string | undefined {
  const payload = (c.data as { payload?: { data?: { tag?: string } } }).payload;
  return payload?.data?.tag;
}

async function waitFor(kind: string, timeoutMs: number): Promise<MessagingWebCaptureEvent> {
  const start = Date.now();
  for (;;) {
    const hit = captures.find((c) => isPrimaryEvent(c) && c.kind === kind);
    if (hit) return hit;
    const err = captures.find((c) => isPrimaryEvent(c) && c.kind === 'error');
    if (err) throw new Error(`page error: ${JSON.stringify(err.data)}`);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${kind}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitFrom(
  kind: string,
  fromIdx: number,
  timeoutMs: number,
): Promise<MessagingWebCaptureEvent> {
  const start = Date.now();
  for (;;) {
    const hit = captures.slice(fromIdx).find((c) => isPrimaryEvent(c) && c.kind === kind);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${kind} (from ${fromIdx})`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function waitTag(
  kind: string,
  tag: string,
  timeoutMs: number,
): Promise<MessagingWebCaptureEvent> {
  const start = Date.now();
  for (;;) {
    const hit = captures.find(
      (c) => isPrimaryEvent(c) && c.kind === kind && tagOf(c) === tag,
    );
    if (hit) return hit;
    const err = captures.find((c) => isPrimaryEvent(c) && c.kind === 'error');
    if (err) throw new Error(`page error: ${JSON.stringify(err.data)}`);
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${kind}#${tag}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

if (SERVE_ONLY) {
  console.log('SERVE-ONLY DEMO:');
  console.log(`Open ${ORIGIN} in your normal browser and click Allow on notifications.`);
  await new Promise(() => {});
}

console.log(`Serving capture app at ${ORIGIN} (headed browser opening)...`);
const channel = process.env.PYRIC_MSG_CHANNEL ?? 'bundled';
const userDataDir = join(process.env.TMPDIR ?? '/tmp', 'pyric-messaging-oracle-profile');
const launchOpts: Parameters<typeof chromium.launchPersistentContext>[1] = {
  headless: false,
  ignoreDefaultArgs: [
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
};
if (channel === 'chrome') {
  launchOpts.channel = 'chrome';
}
const context = await chromium.launchPersistentContext(userDataDir, launchOpts);
await context.grantPermissions(['notifications'], { origin: ORIGIN });
const page = context.pages()[0] ?? (await context.newPage());
const browser = { close: () => context.close() };

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
  console.error(`Notification permission was ${JSON.stringify(perm.data)} - cannot mint a token.`);
  await browser.close();
  server.stop();
  process.exit(1);
}
const tokenCap = await waitFor('token', 30_000);
let activeToken = (tokenCap.data as { token: string }).token;
const initialToken = activeToken;
console.log(`  token minted (${activeToken.length} chars)`);
await waitFor('listening', 15_000);

if (process.env.PYRIC_MSG_DEMO) {
  console.log('DEMO MODE: use the two buttons on the page; Ctrl+C when done.');
  await new Promise(() => {});
}

const results: MessagingWebRawResults = {};
const failures: Record<string, string> = {};

function activateApp(name: string): void {
  spawnSync('osascript', ['-e', `tell application "${name}" to activate`], { stdio: 'ignore' });
}

async function scenario(
  name: MessagingWebScenarioName,
  fn: () => Promise<void>,
): Promise<void> {
  if (!selectedScenarios.has(name)) return;
  console.log(`-- ${name} --`);
  try {
    await fn();
  } catch (e) {
    const msg = (e as Error).stack ?? String(e);
    failures[name] = msg;
    console.error(`scenario failed (${name}): ${msg.split('\n')[0]}`);
  }
}

await scenario('onmessage-foreground', async () => {
  await page.bringToFront();
  const id = await sendTo(activeToken, 'foreground');
  console.log(`  sent foreground: ${id}`);
  results.fg = await waitTag('onMessage', 'foreground', 45_000);
});

await scenario('token-stability', async () => {
  const t2 = (await page.evaluate('window.__getTokenAgain()')) as string;
  results.tokenStable = {
    firstMinted: activeToken.length > 0,
    secondMinted: t2.length > 0,
    tokensEqual: t2 === activeToken,
    sameLength: t2.length === activeToken.length,
  };
  console.log(`  getToken again equal=${t2 === activeToken}`);
});

await scenario('visible-unfocused', async () => {
  await page.bringToFront();
  await new Promise((r) => setTimeout(r, 300));
  activateApp('Finder');
  await new Promise((r) => setTimeout(r, 1000));
  const id = await sendTo(activeToken, 'visible-unfocused');
  console.log(`  sent visible-unfocused: ${id}`);
  results.vuf = await waitTag('onMessage', 'visible-unfocused', 45_000);
  await page.bringToFront();
});

await scenario('data-only-background', async () => {
  await page.goto('about:blank');
  const id = await sendDataOnly(activeToken, 'data-only');
  console.log(`  sent data-only: ${id}`);
  results.dataOnly = await waitTag('onBackgroundMessage', 'data-only', 45_000);
});

await scenario('onbackgroundmessage', async () => {
  if (page.url() !== 'about:blank') {
    await page.goto('about:blank');
  }
  const id = await sendTo(activeToken, 'bg');
  console.log(`  sent bg: ${id}`);
  results.bg = await waitTag('onBackgroundMessage', 'bg', 45_000);
});

await scenario('multi-device-fanout', async () => {
  results.multiDeviceFanout = await runMultiDeviceFanoutScenario({
    chromium,
    channel,
    origin: ORIGIN,
    admin,
    primaryPage: page,
    primaryToken: activeToken,
    captures,
    sendTo,
  });
});

await scenario('token-rotation', async () => {
  const rotation = await runTokenRotationScenario({
    origin: ORIGIN,
    page,
    captures,
    sendTo,
    rawSend,
  });
  results.tokenRotation = rotation.result;
  activeToken = rotation.latestToken;
});

await scenario('deletetoken-unregistered', async () => {
  const mark = captures.length;
  await page.goto(ORIGIN);
  const tokCap = await waitFrom('token', mark, 30_000);
  await waitFrom('listening', mark, 15_000);
  const liveToken = (tokCap.data as { token: string }).token;
  const noLeakFrom = captures.length;
  const del = await page.evaluate('window.__deleteToken()');
  console.log(`  deleteToken resolved: ${JSON.stringify(del)}`);

  let adminThrow: { code?: string; httpStatus?: string; message?: string } | null = null;
  try {
    await sendTo(liveToken, 'deleted-token');
  } catch (e) {
    const fe = e as { code?: string; httpErrorCode?: { status?: string }; message?: string };
    adminThrow = { code: fe.code, httpStatus: fe.httpErrorCode?.status, message: fe.message };
  }

  const first = await rawSend(liveToken, 'deleted-token');
  console.log(`  first raw send after delete: ${first.status}`);
  let unreg: { status: number; body: Record<string, unknown> } | null = null;
  if (first.status >= 400) {
    unreg = first;
  }
  const deadline = Date.now() + 150_000;
  let polls = 0;
  while (!unreg && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8_000));
    polls += 1;
    const r = await rawSend(liveToken, 'deleted-token');
    if (r.status >= 400) {
      unreg = r;
      console.log(`  send plane returned ${r.status} after ${polls} extra poll(s)`);
    }
  }
  const leaked = captures
    .slice(noLeakFrom)
    .some(
      (c) =>
        isPrimaryEvent(c) &&
        (c.kind === 'onMessage' || c.kind === 'onBackgroundMessage') &&
        tagOf(c) === 'deleted-token',
    );

  let unregSummary: { status: number; error?: Record<string, unknown> } | null = null;
  if (unreg !== null) {
    unregSummary = {
      status: unreg.status,
      error: (unreg.body as { error?: Record<string, unknown> }).error,
    };
  }

  results.deleteToken = {
    deleteResolvedTruthy: del === true || del === undefined,
    adminThrow,
    firstSendStatus: first.status,
    acceptedImmediatelyAfterDelete: first.status === 200,
    unregistered: unregSummary,
    noDeliveryToClient: !leaked,
  };
});

if (!selectedScenarios.has('deletetoken-unregistered') && selectedScenarios.has('token-rotation')) {
  // Ensure the rotated token minted by --only token-rotation is deleted on exit.
  await page.evaluate('window.__deleteToken()').catch(() => undefined);
}

await browser.close();
server.stop();
await deleteApp(admin);

writeMessagingWebObservations({
  obsDir: OBS_DIR,
  projectId,
  senderId: webConfig.messagingSenderId,
  fbSdkVersion,
  adminSdkVersion,
  initialToken,
  writeTokenShape: isFullRun,
  results,
});

if (Object.keys(failures).length) {
  console.log('\n-- scenario failures --');
  for (const [k, v] of Object.entries(failures)) console.log(`failed ${k}: ${v.split('\n')[0]}`);
}

console.log('\nDone. Link or register observation exceptions before compat:validate.');
process.exit(0);
