// A server process started with `node --import @pyric/cli/register` and
// PYRIC_SANDBOX=remote:<Node host url> uses the client Firebase SDKs, as a
// script or a server-rendered route does (#1082). They reach the Node host
// with the process's own signed-in user, so the host's rules apply as in
// production: what they write is what firebase-admin and the page read, a
// path the rules deny for that user is denied, and an onDisconnect write runs
// once the process is gone. The services with no path to the host refuse.
// A process started before its host fails its first calls and reaches the
// host at its next call once the host is up, with no restart. A process whose
// host stops and comes back on another port finds it there through
// .pyric/serve.json, for the client SDKs as for firebase-admin.
// Each process stays up only while its SDKs would hold a production process.
// A process started while the host is paused waits for it.
import assert from 'node:assert/strict';
import { scenario, sleep, type App } from '../driver.ts';

/** How long the host is paused: past two of discovery's one-second health probes. */
const HOST_STALL_MS = 2_500;

declare function readBack(): Promise<{ database: unknown; firestore: unknown; aggregate: unknown }>;

type Outcome = { ok: true; value: unknown } | { ok: false; code: string | null; message: string };

function outcome(output: string, name: string): Outcome {
  const match = output.match(new RegExp(`^${name.replaceAll('.', '\\.')} (.*)$`, 'm'));
  assert.ok(match, `no ${name} line in:\n${output}`);
  return JSON.parse(match[1]) as Outcome;
}

function expectOk(output: string, name: string, value: unknown): void {
  assert.deepEqual(outcome(output, name), { ok: true, value }, `${name}:\n${output}`);
}

function expectCode(output: string, name: string, code: string, message?: RegExp): void {
  const result = outcome(output, name);
  assert.equal(result.ok, false, `${name} must fail:\n${output}`);
  if (result.ok) return;
  assert.equal(result.code, code, `${name}:\n${output}`);
  if (message !== undefined) assert.match(result.message, message);
}

const UNSUPPORTED = /^pyric: this client Firebase service does not reach the sandbox host from a server process .* See https:\/\/github\.com\/davideast\/pyric\/issues\/1082\.$/;

/** Runs lifetime.mjs for one case; `held` is whether the process was still up 3 s after its work. */
async function lifetime(app: App, env: Record<string, string>, which: string): Promise<boolean> {
  const { output } = await app.serverScript('lifetime.mjs', [which], { env, timeoutMs: 30_000 });
  assert.match(output, new RegExp(`^${which} done$`, 'm'), output);
  return /^held$/m.test(output);
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const lateEnv = { PYRIC_SANDBOX: `remote:http://127.0.0.1:${port}` };
  const early = await app.step('a process started before the host fails its first calls', async () => {
    const early = app.serverProcess('late-host.mjs', [], { env: lateEnv });
    await early.waitForLog(/^late-host waiting$/m, { timeoutMs: 30_000 });
    assert.equal(outcome(early.output, 'before.database').ok, false, early.output);
    assert.equal(outcome(early.output, 'before.firestore').ok, false, early.output);
    return early;
  });

  const host = await app.step('start the Node host', () => app.devServer({ port }));
  const env = { PYRIC_SANDBOX: `remote:${host.url}` };

  await app.step('the same process reaches the host once it is up, with no restart', async () => {
    app.writeFile('late-host-go', '');
    await early.waitForLog(/^late-host done$/m, { timeoutMs: 30_000 });
    expectOk(early.output, 'after.database', 'after');
    expectOk(early.output, 'after.firestore', { at: 'after' });
  });

  await app.step('firebase-admin seeds the host', async () => {
    const { output } = await app.serverScript('admin.mjs', ['seed'], { env });
    expectOk(output, 'admin.seed.database', null);
    expectOk(output, 'admin.seed.firestore', null);
  });

  const client = await app.step('the client SDKs run in a registered server process and it exits on its own', async () => {
    const { output } = await app.serverScript('client.mjs', [], { env, timeoutMs: 30_000 });
    assert.match(output, /^client done$/m, output);
    return output;
  });

  await app.step('an upload issued before the connection attached went over the byte route', () => {
    expectOk(client, 'storage.upload', 'server/client.txt');
    expectOk(client, 'storage.url', '/__pyric/storage/v0/b/demo-app.appspot.com/o/server%2Fclient.txt');
  });

  await app.step('a resumable upload canceled after its last slice leaves no object once it rejects', () => {
    expectOk(client, 'storage.cancelAfterLastSlice', { rejected: 'storage/canceled', readBack: 'storage/object-not-found' });
  });

  await app.step('RTDB and Firestore read and write the host', () => {
    expectOk(client, 'database.set', null);
    expectOk(client, 'database.get', 'from admin');
    expectOk(client, 'database.connected', true);
    expectOk(client, 'firestore.setDoc', null);
    expectOk(client, 'firestore.getDoc', { from: 'admin' });
  });

  await app.step('getAggregateFromServer aggregates over the host', () => {
    expectOk(client, 'firestore.aggregate', { n: 3 });
  });

  await app.step("the host's rules apply as the process's signed-in user", () => {
    assert.equal(outcome(client, 'auth.createUser').ok, true, client);
    expectOk(client, 'database.ownPath', null);
    expectCode(client, 'database.otherPath', 'PERMISSION_DENIED');
  });

  await app.step('a canceled upload leaves no object under rules that allow its create and deny every delete', () => {
    expectOk(client, 'storage.cancelCreateOnly', { rejected: 'storage/canceled', readBack: 'storage/object-not-found' });
  });

  await app.step('a canceled upload over an existing object keeps the earlier object and its metadata', () => {
    expectOk(client, 'storage.cancelOverwrite', {
      rejected: 'storage/canceled', text: 'v1', customMetadata: { version: 'one' }, sameGeneration: true,
    });
  });

  await app.step('services with no path to the host refuse with failed-precondition', () => {
    expectCode(client, 'ai', 'failed-precondition', UNSUPPORTED);
    expectCode(client, 'messaging', 'failed-precondition', UNSUPPORTED);
    const functions = outcome(client, 'functions');
    assert.equal(functions.ok, false, client);
    assert.match(functions.ok ? '' : functions.message, /'firebase\/functions' is not yet mirrored/);
  });

  await app.step('firebase-admin on the host reads what the client SDKs wrote, and the onDisconnect ran', async () => {
    const { output: cjs } = await app.serverScript('client.cjs', [], { env });
    expectOk(cjs, 'cjs.database', null);
    expectOk(cjs, 'cjs.firestore', null);
    const { output } = await app.serverScript('admin.mjs', [], { env });
    expectOk(output, 'admin.database', 'from client sdk');
    expectOk(output, 'admin.firestore', { from: 'client sdk' });
    expectOk(output, 'admin.auth', 'node@example.com');
    expectOk(output, 'admin.ownPath', 'mine');
    expectOk(output, 'admin.otherPath', null);
    expectOk(output, 'admin.presence', 'gone');
    expectOk(output, 'admin.storage', 'from client sdk');
    expectOk(output, 'admin.cjs', 'from require');
  });

  await app.step('the page on the host reads what the server process wrote, and aggregates over it', async () => {
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'readBack' in window);
    assert.deepEqual(await page.evaluate(() => readBack()), {
      database: 'from client sdk', firestore: { from: 'client sdk' }, aggregate: { n: 4 },
    });
  });

  await app.step('an app with other options gets its calls rejected, and nothing throws past them', async () => {
    const { output } = await app.serverScript('client.cjs', ['other-config'], { env });
    expectCode(output, 'cjs.database', 'app/multiple-configs-not-supported');
    expectCode(output, 'cjs.firestore', 'app/multiple-configs-not-supported');
  });

  await app.step('a process stays up only while its SDKs would hold it in production', async () => {
    assert.equal(await lifetime(app, env, 'storage'), false, 'a finished upload holds nothing');
    assert.equal(await lifetime(app, env, 'firestore'), false, 'a finished Firestore write does not hold the process');
    assert.equal(await lifetime(app, env, 'listener'), true, 'an open Firestore listener holds it');
    assert.equal(await lifetime(app, env, 'rtdb'), true, 'RTDB holds it until goOffline() or deleteApp()');
    assert.equal(await lifetime(app, env, 'offline'), false, 'goOffline() releases it');
  });

  await app.step('a process started while its host is busy waits for it instead of calling it stale', async () => {
    // A busy host answers nothing for longer than discovery's one-second
    // health probe, twice over. Its pointer still names a running process, so
    // the host is not gone (#1527).
    const pid = host.process.pid;
    assert.ok(pid !== undefined, 'the dev server has no pid');
    process.kill(pid, 'SIGSTOP');
    let output: string;
    try {
      const run = app.serverScript('busy-host.mjs', [], { env, timeoutMs: 30_000 });
      await sleep(HOST_STALL_MS);
      process.kill(pid, 'SIGCONT');
      output = (await run).output;
    } finally {
      process.kill(pid, 'SIGCONT');
    }
    assert.doesNotMatch(output, /is stale/, output);
    expectOk(output, 'busy.listener', null);
  });

  const mover = await app.step('a process that discovers its host writes through it', async () => {
    const mover = app.serverProcess('host-move.mjs', [], { env: { PYRIC_SANDBOX: 'remote' } });
    await mover.waitForLog(/^host-move waiting$/m, { timeoutMs: 30_000 });
    expectOk(mover.output, 'first.database', 'first');
    expectOk(mover.output, 'first.firestore', { at: 'first' });
    expectOk(mover.output, 'first.admin', 'first');
    return mover;
  });

  await app.step('stop the host and start it again on another port', async () => {
    await host.process.stop();
    const moved = await app.devServer({ name: 'moved dev server', port: await app.freePort() });
    assert.notEqual(moved.port, port);
    const pointer = JSON.parse(app.readFile('.pyric/serve.json')) as { port: number };
    assert.equal(pointer.port, moved.port, '.pyric/serve.json names the moved host');
  });

  await app.step('the same process reaches the moved host, client SDKs and firebase-admin alike', async () => {
    app.writeFile('host-move-go', '');
    await mover.waitForLog(/^host-move done$/m, { timeoutMs: 60_000 });
    expectOk(mover.output, 'moved.admin', 'moved');
    expectOk(mover.output, 'moved.database', 'moved');
    expectOk(mover.output, 'moved.firestore', { at: 'moved' });
  });
});
