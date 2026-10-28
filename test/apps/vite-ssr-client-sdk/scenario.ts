// Server-rendered modules under `vite dev` import client firebase/* and
// firebase-admin/*, the way a framework's loaders do (#1123). On a hosted dev
// server those imports reach the dev server's own Node host: the client SDKs
// as one signed-in SSR session under the host's rules, firebase-admin as
// admin. Every call is driven through both of Vite's SSR loaders and through
// the externalization settings frameworks use (`ssr.noExternal`). The
// SharedWorker dev server refuses them, naming `hosted: true`. The network
// guard stays on underneath: nothing in this scenario reaches Google. In
// production AI mode the guard permits Firebase AI Logic; egress-stand-in.mjs,
// preloaded into that dev server, stands in for the network beneath the guard
// and refuses what it permits. SSR's config holds the host: a page whose
// config only adds measurementId is accepted, a page with another storage
// bucket is refused, and SSR keeps working after both load. A dev server
// that serves HTTPS with a self-signed certificate is reached the same way,
// over https and wss, and .pyric/serve.json names it with https.
import assert from 'node:assert/strict';
import { get as httpsGet } from 'node:https';
import { scenario, type App, type DevServer } from '../driver.ts';

type Outcome = { ok: true; value: unknown } | { ok: false; code: string | null; message: string };
type Outcomes = Record<string, Outcome>;
interface Run { uid?: string; outcomes: Outcomes }
interface Repro { writeAndRead(tag: string): Promise<{ rtdb: unknown; firestore: unknown }> }
declare const repro: Repro;

/** Production hosts the swapped SDKs would dial, as the guard names them. */
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

/** The refusal text a client service with no path to the host carries. */
const NO_PATH = /does not reach the sandbox host from a server process/;

/** A GET to the HTTPS dev server. Its certificate is self-signed, so this test's own request skips verifying it. */
function getOverHttps(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, { rejectUnauthorized: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function getText(url: string): Promise<{ status: number; body: string }> {
  const isHttps = url.startsWith('https:');
  if (isHttps) return getOverHttps(url);
  const response = await fetch(url);
  return { status: response.status, body: await response.text() };
}

async function get(url: string): Promise<Run> {
  const { status, body } = await getText(url);
  assert.equal(status, 200, `${url}: ${body}`);
  return JSON.parse(body) as Run;
}

const runSsr = (server: DevServer, runner: string, tag: string) =>
  get(`${server.url}/ssr/run?runner=${runner}&tag=${tag}`);

const runAdmin = (server: DevServer, runner: string, uid: string, tag: string) =>
  get(`${server.url}/ssr/admin?runner=${runner}&uid=${uid}&tag=${tag}`);

function expectOk(outcomes: Outcomes, name: string, value: unknown): void {
  assert.deepEqual(outcomes[name], { ok: true, value }, `${name}: ${JSON.stringify(outcomes, null, 2)}`);
}

function expectCode(outcomes: Outcomes, name: string, code: string, message?: RegExp): void {
  const result = outcomes[name];
  assert.ok(result !== undefined && !result.ok, `${name} must fail: ${JSON.stringify(outcomes, null, 2)}`);
  if (result.ok) return;
  assert.equal(result.code, code, `${name}: ${JSON.stringify(result)}`);
  if (message !== undefined) assert.match(result.message, message, name);
}

/** One SSR run on the Node host: the user's own paths work, another user's are denied, as production rules decide. */
function assertRunsAsUser(run: Run, tag: string): string {
  const { outcomes } = run;
  const signIn = outcomes['auth.signIn'];
  assert.ok(signIn?.ok && typeof signIn.value === 'string', `sign-in: ${JSON.stringify(outcomes, null, 2)}`);
  const uid = signIn.value as string;
  expectOk(outcomes, 'database.ownPath', null);
  expectOk(outcomes, 'database.readBack', { from: 'ssr' });
  expectCode(outcomes, 'database.otherPath', 'PERMISSION_DENIED');
  expectOk(outcomes, 'firestore.ownPath', null);
  expectOk(outcomes, 'firestore.readBack', { from: 'ssr' });
  expectCode(outcomes, 'firestore.otherPath', 'permission-denied');
  expectOk(outcomes, 'storage.ownPath', `users/${uid}/${tag}.txt`);
  expectOk(outcomes, 'storage.url', `/__pyric/storage/v0/b/demo-app.appspot.com/o/users%2F${uid}%2F${tag}.txt`);
  expectCode(outcomes, 'storage.otherPath', 'storage/unauthorized');
  expectCode(outcomes, 'ai', 'failed-precondition', NO_PATH);
  expectCode(outcomes, 'messaging', 'failed-precondition', NO_PATH);
  return uid;
}

/** Nothing in the dev server log since `since` shows live Firebase traffic or an answer from it. */
function assertNoProductionTraffic(server: DevServer, since: number): void {
  const log = server.process.output.slice(since);
  for (const host of PRODUCTION_HOSTS) assert.doesNotMatch(log, new RegExp(`net-guard BLOCK ${host.replaceAll('.', '\\.')} `), log);
  for (const answer of PRODUCTION_ANSWERS) assert.doesNotMatch(log, answer, log);
}

/** A dev server in one externalization shape, where SSR reaches the host as its user. */
async function externalizationShape(app: App, noExternal: 'firebase' | 'all', runner: string): Promise<void> {
  const server = await app.step(`start the hosted dev server with ssr.noExternal ${noExternal}`, () =>
    app.devServer({ name: `no-external-${noExternal}`, env: { PYRIC_TEST_NO_EXTERNAL: noExternal } }));
  const since = server.process.mark();
  const tag = `noext-${noExternal}`;
  const uid = await app.step(`ssr.noExternal ${noExternal}: SSR reaches the host as its signed-in user`, async () =>
    assertRunsAsUser(await runSsr(server, runner, tag), tag));
  await app.step(`ssr.noExternal ${noExternal}: SSR firebase-admin reads the user's writes`, async () => {
    const { outcomes } = await runAdmin(server, runner, uid, tag);
    expectOk(outcomes, 'admin.database', { from: 'ssr' });
    expectOk(outcomes, 'admin.firestore', { from: 'ssr' });
  });
  await app.step(`ssr.noExternal ${noExternal}: nothing reached production`, () => assertNoProductionTraffic(server, since));
  await app.step(`stop the ssr.noExternal ${noExternal} dev server`, () => server.process.stop());
}

export default scenario(async (app) => {
  const host = await app.step('start the hosted dev server', () => app.devServer());
  const since = host.process.mark();

  const uid = await app.step('ssrLoadModule: SSR reaches the host as its signed-in user, under the rules', async () =>
    assertRunsAsUser(await runSsr(host, 'legacy', 'legacy'), 'legacy'));

  await app.step('the environment runner: the same SSR session, under the rules', async () => {
    const environmentUid = assertRunsAsUser(await runSsr(host, 'environment', 'environment'), 'environment');
    assert.equal(environmentUid, uid, 'one SSR session per dev server process, as one Node server process has one auth state');
  });

  // The host serves one Firebase config, compared on the keys that pick
  // backend data. SSR sent its config first, verified against this host. A
  // page that only adds measurementId shares it; a page that names another
  // storage bucket is the one refused, and the dev server log says so.
  const writeFromPage = async (variant: string): Promise<Outcome> => {
    const page = await app.page(`${host.url}/measurement.html?variant=${variant}`);
    await page.waitForFunction(() => 'measured' in window);
    const result = await page.evaluate(() => (window as unknown as { measured: { write(): Promise<Outcome> } }).measured.write());
    await page.close();
    return result;
  };

  await app.step('a page whose config adds measurementId is accepted alongside SSR', async () => {
    const result = await writeFromPage('measurement');
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  await app.step('a page whose config names another storage bucket is refused, naming the difference', async () => {
    const logSince = host.process.mark();
    const result = await writeFromPage('bucket');
    assert.equal(result.ok, false, JSON.stringify(result));
    if (result.ok) return;
    assert.equal(result.code, 'app/multiple-configs-not-supported', JSON.stringify(result));
    assert.match(result.message, /differs on: storageBucket/);
    await host.process.waitForLog(/\[pyric\] Refused a client's Firebase config \(differs on: storageBucket\)/, { since: logSince, timeoutMs: 10_000 });
  });

  await app.step('SSR keeps working after both pages loaded', async () => {
    const afterUid = assertRunsAsUser(await runSsr(host, 'legacy', 'after-pages'), 'after-pages');
    assert.equal(afterUid, uid, 'the SSR session survives both pages');
  });

  await app.step('the browser still writes and reads through the sandbox', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'repro' in window);
    const read = await page.evaluate(() => repro.writeAndRead('browser'));
    assert.deepEqual(read, { rtdb: { from: 'browser' }, firestore: { from: 'browser' } });
  });

  await app.step('SSR firebase-admin reads past the rules, through both loaders', async () => {
    for (const runner of ['legacy', 'environment']) {
      const { outcomes } = await runAdmin(host, runner, uid, runner);
      expectOk(outcomes, 'admin.database', { from: 'ssr' });
      expectOk(outcomes, 'admin.firestore', { from: 'ssr' });
      expectOk(outcomes, 'admin.browser', { from: 'browser' });
    }
  });

  await app.step('firebase-admin on the host reads every SSR write, and none to another user', async () => {
    const result = await app.serverScript('admin-read.mjs', [`${uid}/legacy`, `${uid}/environment`, 'browser'], {
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
    });
    for (const tag of ['legacy', 'environment']) {
      const expected = { rtdb: { from: 'ssr' }, firestore: { from: 'ssr' }, storage: 'ssr', other: null };
      assert.ok(result.output.includes(`${tag}: ${JSON.stringify(expected)}`), result.output);
    }
    assert.match(result.output, /browser: \{"rtdb":\{"from":"browser"\},"firestore":\{"from":"browser"\}\}/);
  });

  await app.step('no SSR call reached live Firebase', () => assertNoProductionTraffic(host, since));
  await app.step('stop the hosted dev server', () => host.process.stop());

  await externalizationShape(app, 'firebase', 'environment');
  await externalizationShape(app, 'all', 'legacy');

  const secure = await app.step('start the hosted dev server over HTTPS, with a generated self-signed certificate', () =>
    app.devServer({ name: 'https-dev-server', https: true, env: { PYRIC_TEST_HTTPS: '1' } }));
  const secureSince = secure.process.mark();
  const secureUid = await app.step('HTTPS: SSR reaches the host as its signed-in user, under the rules', async () =>
    assertRunsAsUser(await runSsr(secure, 'legacy', 'https'), 'https'));
  await app.step('HTTPS: SSR firebase-admin reads the user\'s writes', async () => {
    const { outcomes } = await runAdmin(secure, 'environment', secureUid, 'https');
    expectOk(outcomes, 'admin.database', { from: 'ssr' });
    expectOk(outcomes, 'admin.firestore', { from: 'ssr' });
  });
  await app.step('HTTPS: .pyric/serve.json names the dev server with https', () => {
    const pointer = JSON.parse(app.readFile('.pyric/serve.json')) as { url: string; port: number };
    assert.equal(pointer.port, secure.port, JSON.stringify(pointer));
    assert.match(pointer.url, /^https:\/\//, JSON.stringify(pointer));
  });
  await app.step('HTTPS: nothing reached production', () => assertNoProductionTraffic(secure, secureSince));
  await app.step('stop the HTTPS dev server', () => secure.process.stop());

  const worker = await app.step('start the SharedWorker dev server', () =>
    app.devServer({ name: 'shared-worker-dev-server', env: { PYRIC_TEST_HOSTED: '0' } }));
  await app.step('SharedWorker mode: SSR client and admin calls refuse, naming hosted: true', async () => {
    const workerSince = worker.process.mark();
    for (const runner of ['legacy', 'environment']) {
      const { outcomes } = await runSsr(worker, runner, `worker-${runner}`);
      for (const name of ['auth.signIn', 'database.ownPath', 'firestore.ownPath', 'storage.ownPath']) {
        expectCode(outcomes, name, 'failed-precondition', /hosted: true/);
      }
      const admin = await runAdmin(worker, runner, 'someone', `worker-${runner}`);
      expectCode(admin.outcomes, 'admin.database', 'failed-precondition', /hosted: true/);
    }
    assertNoProductionTraffic(worker, workerSince);
  });
  await app.step('stop the SharedWorker dev server', () => worker.process.stop());

  const production = await app.step('start the hosted dev server in production AI mode, over the egress stand-in', () =>
    app.devServer({
      name: 'production-ai-dev-server',
      env: { PYRIC_AI_MODE: 'production', NODE_OPTIONS: '--import ./egress-stand-in.mjs' },
    }));

  await app.step('production AI mode: SSR firebase/ai goes out, and only to Firebase AI Logic', async () => {
    const since = production.process.mark();
    const { outcomes } = await get(`${production.url}/ssr/run-ai?runner=legacy`);
    assert.equal(outcomes.ai?.ok, false, `firebase/ai: ${JSON.stringify(outcomes)}`);
    await production.process.waitForLog(/\[egress stand-in\] refused fetch to /, { since, timeoutMs: 10_000 });
    const log = production.process.output.slice(since);
    const refused = [...log.matchAll(/\[egress stand-in\] refused fetch to (\S+)/g)].map((match) => match[1]!);
    assert.deepEqual(refused, ['firebasevertexai.googleapis.com'], `dev server log:\n${log}`);
    assert.doesNotMatch(log, /net-guard BLOCK/);
  });
  await app.step('stop the production AI mode dev server', () => production.process.stop());

  await app.step('a dev server created through the API ends on its own after SSR used RTDB', async () => {
    const startedAt = Date.now();
    const { output } = await app.serverScript('programmatic.mjs', [], { timeoutMs: 60_000 });
    assert.match(output, /^programmatic\.database \{"ok":true,"value":null\}$/m, output);
    assert.match(output, /^programmatic closed$/m, output);
    assert.ok(Date.now() - startedAt < 60_000, output);
  });
});
