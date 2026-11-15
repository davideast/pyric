// Every `pyric mcp` session serves the same ten service tools whether started
// before or after a Node host and whether started inside or outside the
// project directory. Every tool result carries `_pyric.{projectDir, isProject,
// target}`, and `initialize.instructions` names the project directory and
// target (warning when no project markers were found).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenario, sleep, type App } from '../driver.ts';

interface ProbeOutput {
  started: boolean;
  exitCode?: number | null;
  init?: { instructions?: string };
  tools?: string[];
  isError?: boolean;
  body?: {
    ok?: boolean;
    data?: { exists?: boolean; value?: unknown };
    _pyric?: {
      mode?: string;
      project?: string;
      target?: string;
      projectDir?: string;
      isProject?: boolean;
    };
  };
}

async function runProbe(app: App, workDir: string, mcpArgs: string[]): Promise<ProbeOutput> {
  const cliPath = join(app.dir, 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');
  const { code, output } = await app.command(
    'node',
    ['mcp-probe.mjs', cliPath, workDir, ...mcpArgs],
    { timeoutMs: 45_000 },
  );
  assert.equal(code, 0, output);
  const line = output.split('\n').find((entry) => entry.startsWith('probe '));
  assert.ok(line, `no probe line in:\n${output}`);
  return JSON.parse(line.slice('probe '.length)) as ProbeOutput;
}

export default scenario(async (app) => {
  const port = await app.freePort();
  const realProject = realpathSync(app.dir);
  const outsideBefore = join(app.dir, '..', 'outside-before');
  const outsideAfter = join(app.dir, '..', 'outside-after');
  mkdirSync(outsideBefore, { recursive: true });
  mkdirSync(outsideAfter, { recursive: true });
  const realOutsideBefore = realpathSync(outsideBefore);
  const realOutsideAfter = realpathSync(outsideAfter);
  const cliPath = join(app.dir, 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');
  const triggerFile = join(outsideBefore, 'continue.signal');

  const earlySession = await app.step('start pyric mcp in the project before the Node host exists', async () => {
    const proc = app.commandProcess('node', ['mcp-probe.mjs', `--wait-file=${triggerFile}`, cliPath, app.dir]);
    await proc.waitForLog(/^ready \{/m, { timeoutMs: 30_000 });
    return proc;
  });

  const beforeOutside = await app.step('pyric mcp started outside before host names its non-project directory', async () => {
    const result = await runProbe(app, outsideBefore, []);
    assert.equal(result.started, true);
    assert.equal(result.tools?.length, 10);
    assert.equal(result.body?._pyric?.target, 'in-process');
    assert.equal(result.body?._pyric?.projectDir, realOutsideBefore);
    assert.equal(result.body?._pyric?.isProject, false);
    assert.ok(result.init?.instructions?.includes(realOutsideBefore));
    return result;
  });

  const host = await app.step('start the hosted Node sandbox and seed items/a via CLI', async () => {
    const proc = app.pyricProcess(['sandbox', '--hosted', '--no-open', '--no-run', '--host', '127.0.0.1', '--port', String(port)]);
    const pointer = join(app.dir, '.pyric', 'serve.json');
    const deadline = Date.now() + 60_000;
    while (!existsSync(pointer)) {
      if (Date.now() > deadline) throw new Error(`serve.json not written:\n${proc.output}`);
      await sleep(200);
    }
    const write = await app.pyric(['database', 'set', '--path', 'items/a', '--value', '{"n":1}']);
    assert.equal(write.code, 0, write.output);
    return proc;
  });

  await app.step('the pre-host session follows the Node host with the same 10 tools', async () => {
    await sleep(1_200);
    writeFileSync(triggerFile, 'go\n', 'utf8');
    await earlySession.waitForLog(/^probe \{/m, { timeoutMs: 30_000 });
    const line = earlySession.output.split('\n').find((entry) => entry.startsWith('probe '));
    assert.ok(line, earlySession.output);
    const result = JSON.parse(line.slice('probe '.length)) as ProbeOutput;
    assert.deepEqual(result.tools, beforeOutside.tools);
    assert.deepEqual(result.body?.data?.value, { n: 1 });
    assert.equal(result.body?._pyric?.target, 'host');
    assert.equal(result.body?._pyric?.projectDir, realProject);
    assert.equal(result.body?._pyric?.isProject, true);
    await earlySession.stop();
  });

  await app.step('after-host sessions keep identical 10 tools in project, outside, and with --project-dir', async () => {
    const afterInProject = await runProbe(app, app.dir, []);
    assert.deepEqual(afterInProject.tools, beforeOutside.tools);
    assert.deepEqual(afterInProject.body?.data?.value, { n: 1 });
    assert.equal(afterInProject.body?._pyric?.target, 'host');
    assert.equal(afterInProject.body?._pyric?.projectDir, realProject);
    assert.equal(afterInProject.body?._pyric?.isProject, true);
    assert.ok(afterInProject.init?.instructions?.includes(realProject));

    const afterOutside = await runProbe(app, outsideAfter, []);
    assert.deepEqual(afterOutside.tools, beforeOutside.tools);
    assert.equal(afterOutside.body?.data?.exists, false);
    assert.equal(afterOutside.body?._pyric?.target, 'in-process');
    assert.equal(afterOutside.body?._pyric?.projectDir, realOutsideAfter);
    assert.equal(afterOutside.body?._pyric?.isProject, false);
    assert.ok(afterOutside.init?.instructions?.includes(realOutsideAfter));

    const afterWithDir = await runProbe(app, outsideAfter, ['--project-dir', app.dir]);
    assert.deepEqual(afterWithDir.tools, beforeOutside.tools);
    assert.deepEqual(afterWithDir.body?.data?.value, { n: 1 });
    assert.equal(afterWithDir.body?._pyric?.target, 'host');
    assert.equal(afterWithDir.body?._pyric?.projectDir, realProject);
    assert.equal(afterWithDir.body?._pyric?.isProject, true);
    assert.ok(afterWithDir.init?.instructions?.includes(realProject));

    await host.stop();
  });
});
