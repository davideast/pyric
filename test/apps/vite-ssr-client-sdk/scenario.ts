// Server-rendered modules under `vite dev` import client firebase/*. Vite
// externalizes installed packages for SSR before plugins resolve them, so
// those imports load the real SDK (#1123). Until the plugin routes them, the
// dev server's network guard refuses their connections to live Firebase.
// Each call is driven through both of Vite's SSR loaders. In production AI
// mode the guard permits Firebase AI Logic; egress-stand-in.mjs, preloaded
// into that dev server, stands in for the network beneath the guard and
// refuses what it permits, so nothing in this scenario reaches Google.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { scenario } from '../driver.ts';

interface Outcome { state: 'pending' | 'resolved' | 'rejected'; code?: string | null; message?: string; ms?: number }
type Outcomes = Record<string, Outcome>;
interface Repro { writeAndRead(tag: string): Promise<{ rtdb: unknown; firestore: unknown }> }
declare const repro: Repro;

/** Production hosts each SDK dials, as the guard names them. */
const PRODUCTION_HOSTS = [
  'identitytoolkit.googleapis.com',
  'demo-app-default-rtdb.firebaseio.com',
  'firestore.googleapis.com',
  'firebasestorage.googleapis.com',
  'firebasevertexai.googleapis.com',
];

/** What the dev server log shows when a live Firebase backend answered. */
const PRODUCTION_ANSWERS = [
  /api-key-not-valid/,
  /Permission denied on resource project/,
  /Please ensure that you have the URL of your Firebase Realtime Database instance configured correctly/,
];

async function ssr(url: string, action: 'start' | 'status', runner: string, tag: string): Promise<Outcomes> {
  const response = await fetch(`${url}/ssr/${action}?runner=${runner}&tag=${tag}`);
  const body = await response.text();
  assert.equal(response.status, 200, `SSR ${action} through ${runner}: ${body}`);
  return JSON.parse(body) as Outcomes;
}

/** Polls until `label` settles. Sign-in and firebase/ai report a refused connection to their caller. */
async function settled(url: string, runner: string, tag: string, label: string): Promise<Outcomes> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const outcomes = await ssr(url, 'status', runner, tag);
    if (outcomes[label]?.state !== 'pending') return outcomes;
    assert.ok(Date.now() < deadline, `${label} did not settle: ${JSON.stringify(outcomes)}`);
    await delay(100);
  }
}

const settledSignIn = (url: string, runner: string, tag: string) =>
  settled(url, runner, tag, 'auth.signInAnonymously');

/** Each host the egress stand-in refused, in order. */
function standInRefusals(log: string): string[] {
  return [...log.matchAll(/\[egress stand-in\] refused fetch to (\S+)/g)].map((match) => match[1]!);
}

function assertRefused(outcomes: Outcomes, runner: string): void {
  const signIn = outcomes['auth.signInAnonymously']!;
  assert.equal(signIn.code, 'auth/network-request-failed', `${runner} sign-in reached a backend: ${JSON.stringify(signIn)}`);
  assert.ok((signIn.ms ?? Infinity) < 5_000, `${runner} sign-in took ${signIn.ms} ms to fail`);
  for (const [label, outcome] of Object.entries(outcomes)) {
    assert.notEqual(outcome.state, 'resolved', `${runner} ${label} succeeded: ${JSON.stringify(outcome)}`);
  }
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const since = host.process.mark();

  await app.step('ssrLoadModule: sign-in fails at once and no call succeeds', async () => {
    await ssr(host.url, 'start', 'legacy', 'legacy');
    assertRefused(await settledSignIn(host.url, 'legacy', 'legacy'), 'ssrLoadModule');
  });

  await app.step('the guard refuses each SDK connection to live Firebase and names #1123', async () => {
    for (const productionHost of PRODUCTION_HOSTS) {
      const escaped = productionHost.replaceAll('.', '\\.');
      await host.process.waitForLog(new RegExp(`net-guard BLOCK ${escaped} `), { since, timeoutMs: 10_000 });
    }
    await host.process.waitForLog(/issues\/1123/, { since, timeoutMs: 1_000 });
  });

  await app.step('the environment runner: sign-in fails at once and no call succeeds', async () => {
    await ssr(host.url, 'start', 'environment', 'environment');
    assertRefused(await settledSignIn(host.url, 'environment', 'environment'), 'environment runner');
  });

  await app.step('no live Firebase backend answered the dev server', () => {
    const log = host.process.output.slice(since);
    for (const answer of PRODUCTION_ANSWERS) assert.doesNotMatch(log, answer);
  });

  await app.step('the browser still writes and reads through the sandbox', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'repro' in window);
    const read = await page.evaluate(() => repro.writeAndRead('browser'));
    assert.deepEqual(read, { rtdb: { from: 'browser' }, firestore: { from: 'browser' } });
  });

  await app.step('the host holds the browser writes and none of the SSR writes', async () => {
    const result = await app.serverScript('admin-read.mjs', ['legacy', 'environment', 'browser'], {
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
    });
    assert.match(result.output, /legacy: \{"rtdb":null,"firestore":null\}/);
    assert.match(result.output, /environment: \{"rtdb":null,"firestore":null\}/);
    assert.match(result.output, /browser: \{"rtdb":\{"from":"browser"\},"firestore":\{"from":"browser"\}\}/);
  });

  await app.step('stop the sandbox AI mode dev server', () => host.process.stop());

  const production = await app.step('start the hosted dev server in production AI mode, over the egress stand-in', () =>
    app.devServer({
      name: 'production-ai-dev-server',
      env: { PYRIC_AI_MODE: 'production', NODE_OPTIONS: '--import ./egress-stand-in.mjs' },
    }));

  await app.step('production AI mode: the guard lets SSR firebase/ai out, and only to Firebase AI Logic', async () => {
    const since = production.process.mark();
    await ssr(production.url, 'start-ai', 'legacy', 'ai');
    const outcomes = await settled(production.url, 'legacy', 'ai', 'ai.generateContent');
    assert.equal(outcomes['ai.generateContent']!.state, 'rejected', `firebase/ai: ${JSON.stringify(outcomes)}`);
    await production.process.waitForLog(/\[egress stand-in\] refused fetch to /, { since, timeoutMs: 10_000 });
    const log = production.process.output.slice(since);
    assert.deepEqual(standInRefusals(log), ['firebasevertexai.googleapis.com'], `dev server log:\n${log}`);
    assert.doesNotMatch(log, /net-guard BLOCK/);
  });
});
