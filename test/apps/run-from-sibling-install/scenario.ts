// Pyric is installed in a sibling tools/ folder, never in the web app or the
// backend. Bare `@pyric/cli/...` specifiers cannot resolve from those trees.
// The Vite config loads the plugin through createRequire on the tools
// install, and the backend runs through that install's `pyric run`, which
// hands Node the register module by absolute file URL.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

export default scenario(async (app) => {
  await app.step('install pyric in tools/ and firebase-admin in backend/', async () => {
    await app.installProject('tools');
    await app.installProject('backend');
  });

  const host = await app.step('the Vite config loads the plugin from the sibling install', () => app.devServer());

  await app.step('the host serves /__pyric/health', async () => {
    const response = await fetch(`${host.url}/__pyric/health`);
    assert.equal(response.status, 200);
    const health = (await response.json()) as { instanceId?: unknown };
    assert.equal(typeof health.instanceId, 'string');
  });

  await app.step('a bare --import @pyric/cli/register cannot resolve from backend/', async () => {
    const bare = await app.command('node', ['--import', '@pyric/cli/register', 'write.mjs', 'unreachable'], {
      cwd: 'backend',
      env: { PYRIC_SANDBOX: `remote:${host.url}` },
    });
    assert.notEqual(bare.code, 0, bare.output);
    assert.match(bare.output, /ERR_MODULE_NOT_FOUND/);
  });

  await app.step('pyric run from tools/ runs the backend against the host', async () => {
    const write = await app.command(
      '../tools/node_modules/.bin/pyric',
      ['run', '--sandbox', host.url, '--', 'node', 'write.mjs', 'from the backend'],
      { cwd: 'backend' },
    );
    assert.equal(write.code, 0, write.output);
    assert.match(write.output, /status set to from the backend/);
  });

  await app.step('a second process reads the write back from the same host', async () => {
    const read = await app.command(
      '../tools/node_modules/.bin/pyric',
      ['run', '--sandbox', host.url, '--', 'node', 'read.mjs'],
      { cwd: 'backend' },
    );
    assert.equal(read.code, 0, read.output);
    assert.match(read.output, /status is from the backend/);
  });

  await app.step('pyric run --wait started before the host attaches once it is up', async () => {
    await host.process.stop();
    const port = await app.freePort();
    const url = `http://127.0.0.1:${port}`;
    const run = app.command(
      '../tools/node_modules/.bin/pyric',
      ['run', '--sandbox', url, '--wait', '--', 'node', 'write.mjs', 'after waiting'],
      { cwd: 'backend' },
    );
    await app.devServer({ port });
    const write = await run;
    assert.equal(write.code, 0, write.output);
    assert.match(write.output, /status set to after waiting/);
  });

  await app.step('pyric run --wait gives up with exit 2 when no host comes', async () => {
    const url = `http://127.0.0.1:${await app.freePort()}`;
    const run = await app.command(
      '../tools/node_modules/.bin/pyric',
      ['run', '--sandbox', url, '--wait=1', '--', 'node', 'write.mjs', 'never'],
      { cwd: 'backend' },
    );
    assert.equal(run.code, 2, run.output);
    assert.match(run.output, /no sandbox host answers at .* after waiting 1s/);
  });
});
