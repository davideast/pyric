// `pyric run --sandbox <url> --wait` against the create-pyric web template's
// own Vite dev server (#1568). The template's plugin is in-page, `pyric()`
// with no `hosted`, so that server has no sandbox host. It still answers
// `/__pyric/health`, but not with the health reply.
//
// On main, `pyric run` took that answer for "nothing yet", waited out the
// whole `--wait`, and failed without naming the fix. It should fail at once
// and name `pyric({ hosted: true })`. With that one change in vite.config.ts,
// the same command reaches the host and runs.
//
// A hosted server that restarts must not look like one that never had a
// host. A config edit restarts Vite, and the new plugin instance closes the
// old generation before it builds its own, while the old server still
// answers. `pyric run --wait` started in that window waits for the restarted
// host, and a restart that fails reads as a host that went away.
import assert from 'node:assert/strict';
import { scenario, sleep, type App, type DevServer, type ScriptResult } from '../driver.ts';

const PROJECT = 'my-web';
const CONFIG = `${PROJECT}/vite.config.ts`;
const WAIT_SECONDS = 5;
/** Well before the wait expires: a refusal decided by one probe, with room for a busy machine. */
const REFUSAL_LIMIT_MS = 3000;
/** How long the added plugin holds a restart open, so a command starts inside it every time. */
const RESTART_HOLD_MS = 3000;
/** A plugin whose configureServer runs after pyric's, holding a restart open. */
const HOLD_RESTART_PLUGIN =
  `{ name: 'hold-restart', configureServer: () => new Promise((done) => setTimeout(done, ${RESTART_HOLD_MS})) }`;

/** Runs the scaffolded project's `pyric run` against `host`, and how long it took. */
async function pyricRun(
  app: App,
  host: DevServer,
  script: string,
  waitFlags: string[] = [`--wait=${WAIT_SECONDS}`],
): Promise<{ result: ScriptResult; ms: number }> {
  const started = Date.now();
  const result = await app.command(
    'node_modules/.bin/pyric',
    ['run', '--sandbox', host.url, ...waitFlags, '--', 'node', '-e', script],
    { cwd: PROJECT },
  );
  return { result, ms: Date.now() - started };
}

/** Edits the scaffolded vite.config.ts, which Vite answers by restarting. */
function editConfig(app: App, from: string, to: string): void {
  const config = app.readFile(CONFIG);
  const edited = config.replace(from, to);
  assert.notEqual(edited, config, `vite.config.ts has no ${JSON.stringify(from)} to edit`);
  app.writeFile(CONFIG, edited);
}

/** Waits until the host's health stops giving its 200 reply, which a restart starts with. */
async function healthStopsAnswering(host: DevServer): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const status = await fetch(`${host.url}/__pyric/health`, { headers: { accept: 'application/json' } })
      .then((response) => response.status, () => 0);
    if (status !== 200) return;
    assert.ok(Date.now() < deadline, 'the hosted server kept answering health 15 s after the config edit');
    await sleep(50);
  }
}

export default scenario(async (app) => {
  await app.step('create-pyric scaffolds the web template', async () => {
    const result = await app.command('node', ['node_modules/create-pyric/dist/bin.js', PROJECT, '--template', 'web']);
    assert.equal(result.code, 0, result.output);
  });

  await app.step('install the scaffolded project', () => app.installProject(PROJECT));

  const inPage = await app.step('start the template dev server as scaffolded', () => app.devServer({ cwd: PROJECT }));

  await app.step('pyric run refuses the in-page server at once and names hosted: true', async () => {
    const { result, ms } = await pyricRun(app, inPage, '0');
    console.log(`pyric run against the in-page server: exit ${result.code} after ${ms} ms`);
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /a Vite server without a hosted pyric sandbox/, result.output);
    assert.match(result.output, /pyric\(\{ hosted: true \}\) in vite\.config\.ts/, result.output);
    assert.ok(ms < REFUSAL_LIMIT_MS, `pyric run took ${ms} ms to refuse, with --wait=${WAIT_SECONDS}`);
  });

  await app.step('turn on the Node host in the scaffolded vite.config.ts', async () => {
    await inPage.process.stop();
    editConfig(app, 'pyric({', 'pyric({\n      hosted: true,');
  });

  const hosted = await app.step('restart the dev server on the same port', () =>
    app.devServer({ cwd: PROJECT, port: inPage.port }));

  await app.step('the same pyric run reaches the hosted server and runs its command', async () => {
    const { result, ms } = await pyricRun(app, hosted, "console.log('reached the host')");
    console.log(`pyric run against the hosted server: exit ${result.code} after ${ms} ms`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /reached the host/, result.output);
  });

  await app.step('a config edit starts a restart of the hosted server', async () => {
    editConfig(app, '  plugins: [', `  plugins: [\n    ${HOLD_RESTART_PLUGIN},`);
    await healthStopsAnswering(hosted);
  });

  await app.step('pyric run --wait started during the restart runs on the restarted host', async () => {
    const { result, ms } = await pyricRun(app, hosted, "console.log('reached the restarted host')", ['--wait=60']);
    console.log(`pyric run during the restart: exit ${result.code} after ${ms} ms`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /reached the restarted host/, result.output);
  });

  // The restart fails after pyric closed the old generation (the seed file
  // does not exist), so the old server stays up with no sandbox host.
  await app.step('a config edit whose restart fails', async () => {
    editConfig(app, 'hosted: true,', "hosted: true,\n      seed: './missing-seed.json',");
    await healthStopsAnswering(hosted);
  });

  await app.step('pyric run after the failed restart says no host answers, not to set hosted: true', async () => {
    const { result, ms } = await pyricRun(app, hosted, '0', []);
    console.log(`pyric run after the failed restart: exit ${result.code} after ${ms} ms`);
    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /no sandbox host answers at /, result.output);
    assert.doesNotMatch(result.output, /hosted: true/, result.output);
  });
});
