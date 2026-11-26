import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPrivateJobTmpDir, removePrivateJobTmpDir } from '../../scripts/lib/private-job-tmpdir.ts';
import { AppRun, DEFAULT_PROCESS_TIMING, type ProcessTiming } from './driver.ts';

const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    removePrivateJobTmpDir(dir);
  }
});

function createAppFixture(label: string, timing: ProcessTiming = DEFAULT_PROCESS_TIMING): {
  app: AppRun;
  appDir: string;
} {
  const root = createPrivateJobTmpDir(label);
  tempRoots.push(root);
  const appDir = join(root, 'app');
  const homeDir = join(root, 'home');
  mkdirSync(join(appDir, 'node_modules', '@pyric', 'cli', 'dist', 'cli'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    join(appDir, 'node_modules', '@pyric', 'cli', 'package.json'),
    '{"name":"@pyric/cli","type":"module","exports":{"./register":"./register.js"}}\n',
  );
  writeFileSync(join(appDir, 'node_modules', '@pyric', 'cli', 'register.js'), 'export {};\n');
  const noBrowser = () => Promise.reject(new Error('no browser in this test'));
  const app = new AppRun('timeout-diagnostics', appDir, homeDir, noBrowser, undefined, undefined, timing);
  return { app, appDir };
}

describe('AppRun timeout output flushing and group diagnostics (#2140)', () => {
  test('command() flushes stdout/stderr written before and on SIGTERM and names live group processes', async () => {
    const { app, appDir } = createAppFixture('cmd-timeout');
    writeFileSync(
      join(appDir, 'probe.mjs'),
      [
        "process.stdout.write('step 1: initialized\\n');",
        "process.stderr.write('step 2: waiting on credentials\\n');",
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('step 3: sigterm-flush\\n', () => process.exit(0));",
        '});',
        'setInterval(() => {}, 10_000);',
      ].join('\n'),
    );

    let thrownMessage = '';
    try {
      await app.command('node', ['probe.mjs', 'credentials'], { timeoutMs: 250 });
    } catch (error) {
      if (error instanceof Error) {
        thrownMessage = error.message;
      } else {
        thrownMessage = String(error);
      }
    } finally {
      await app.close();
    }

    expect(thrownMessage).toStartWith('node probe.mjs credentials did not exit within 0.25s:\n');
    expect(thrownMessage).toContain('step 1: initialized');
    expect(thrownMessage).toContain('step 2: waiting on credentials');
    expect(thrownMessage).toContain('step 3: sigterm-flush');
    expect(thrownMessage).toContain('timed out after 0.25s; processes in its group:');
    if (process.platform === 'linux') {
      expect(thrownMessage).toMatch(/pid \d+ parent \d+ state \w: .*probe\.mjs credentials/);
    }
  }, 15_000);

  test('pyric() names both the CLI process and its hung child probe in the timeout report', async () => {
    const { app, appDir } = createAppFixture('pyric-timeout');
    writeFileSync(
      join(appDir, 'probe.mjs'),
      [
        "process.stdout.write('probe: checking metadata endpoint\\n');",
        'setInterval(() => {}, 10_000);',
      ].join('\n'),
    );
    writeFileSync(
      join(appDir, 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js'),
      [
        "import { spawn } from 'node:child_process';",
        "process.stdout.write('sandbox: ready\\n');",
        "const child = spawn('node', ['probe.mjs', 'credentials'], { stdio: 'inherit' });",
        "process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(143); });",
        'setInterval(() => {}, 10_000);',
      ].join('\n'),
    );

    let thrownMessage = '';
    try {
      await app.pyric(['sandbox', '--no-open', '--', 'node', 'probe.mjs', 'credentials'], { timeoutMs: 300 });
    } catch (error) {
      if (error instanceof Error) {
        thrownMessage = error.message;
      } else {
        thrownMessage = String(error);
      }
    } finally {
      await app.close();
    }

    expect(thrownMessage).toStartWith(
      'pyric sandbox --no-open -- node probe.mjs credentials did not exit within 0.3s:\n',
    );
    expect(thrownMessage).toContain('sandbox: ready');
    expect(thrownMessage).toContain('probe: checking metadata endpoint');
    expect(thrownMessage).toContain('timed out after 0.3s; processes in its group:');
    if (process.platform === 'linux') {
      expect(thrownMessage).toMatch(/pid \d+ parent \d+ state \w: .*probe\.mjs credentials/);
    }
  }, 15_000);

  test('serverScript() reports output-socket diagnostics when a background session holds pipes past SIGKILL', async () => {
    const fastStopTiming: ProcessTiming = {
      exit: DEFAULT_PROCESS_TIMING.exit,
      stop: { termMs: 150, killMs: 150 },
    };
    const { app, appDir } = createAppFixture('srv-timeout', fastStopTiming);
    writeFileSync(
      join(appDir, 'hang-holder.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "const detached = spawn('sleep', ['30'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
        "process.stdout.write(`holder:${String(detached.pid)}\\n`);",
        'setInterval(() => {}, 10_000);',
      ].join('\n'),
    );

    let holderPid = 0;
    let thrownMessage = '';
    try {
      await app.serverScript('hang-holder.mjs', [], { timeoutMs: 250 });
    } catch (error) {
      if (error instanceof Error) {
        thrownMessage = error.message;
      } else {
        thrownMessage = String(error);
      }
      const match = /holder:(\d+)/.exec(thrownMessage);
      if (match && match[1]) {
        holderPid = Number(match[1]);
      }
    } finally {
      if (holderPid > 0) {
        try {
          process.kill(-holderPid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
      await app.close();
    }

    expect(thrownMessage).toStartWith('hang-holder.mjs did not exit within 0.25s:\n');
    expect(thrownMessage).toContain('did not close within 0.15s of SIGKILL');
    expect(thrownMessage).toContain('timed out after 0.25s; processes in its group:');
    if (process.platform === 'linux') {
      expect(thrownMessage).toContain('output sockets:');
    }
  }, 15_000);
});
