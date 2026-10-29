// `pyric run --sandbox <url> --wait` against the create-pyric web template's
// own Vite dev server (#1568). The template's plugin is in-page, `pyric()`
// with no `hosted`, so that server has no sandbox host. It still answers
// `/__pyric/health`, but not with the health reply.
//
// On main, `pyric run` took that answer for "nothing yet", waited out the
// whole `--wait`, and failed without naming the fix. It should fail at once
// and name `pyric({ hosted: true })`. With that one change in vite.config.ts,
// the same command reaches the host and runs.
import assert from 'node:assert/strict';
import { scenario, type App, type DevServer, type ScriptResult } from '../driver.ts';

const PROJECT = 'my-web';
const WAIT_SECONDS = 5;
/** Well before the wait expires: a refusal decided by one probe, with room for a busy machine. */
const REFUSAL_LIMIT_MS = 3000;

/** Runs the scaffolded project's `pyric run` against `host`, and how long it took. */
async function pyricRun(app: App, host: DevServer, script: string): Promise<{ result: ScriptResult; ms: number }> {
  const started = Date.now();
  const result = await app.command(
    'node_modules/.bin/pyric',
    ['run', '--sandbox', host.url, `--wait=${WAIT_SECONDS}`, '--', 'node', '-e', script],
    { cwd: PROJECT },
  );
  return { result, ms: Date.now() - started };
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
    assert.match(result.output, /in-page Vite/, result.output);
    assert.match(result.output, /pyric\(\{ hosted: true \}\)/, result.output);
    assert.match(result.output, /vite\.config\.ts/, result.output);
    assert.ok(ms < REFUSAL_LIMIT_MS, `pyric run took ${ms} ms to refuse, with --wait=${WAIT_SECONDS}`);
  });

  await app.step('turn on the Node host in the scaffolded vite.config.ts', async () => {
    await inPage.process.stop();
    const path = `${PROJECT}/vite.config.ts`;
    const config = app.readFile(path);
    const edited = config.replace('pyric({', 'pyric({\n      hosted: true,');
    assert.notEqual(edited, config, 'the scaffolded vite.config.ts has no pyric({ call to edit');
    app.writeFile(path, edited);
  });

  const hosted = await app.step('restart the dev server on the same port', () =>
    app.devServer({ cwd: PROJECT, port: inPage.port }));

  await app.step('the same pyric run reaches the hosted server and runs its command', async () => {
    const { result, ms } = await pyricRun(app, hosted, "console.log('reached the host')");
    console.log(`pyric run against the hosted server: exit ${result.code} after ${ms} ms`);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /reached the host/, result.output);
  });
});
