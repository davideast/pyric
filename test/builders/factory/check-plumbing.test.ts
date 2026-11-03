// The check's plumbing: an aborted runner ends its whole process group; the
// tests gate, the check's Studio and the served copy get the run's ffmpeg,
// and the tests gate Playwright's browsers and Chromium; a
// lockfile naming a source other than the registry is named; a check that
// throws still writes a failed result and points `latest` and `hour-<n>` at
// it, in a fresh folder that keeps an earlier run of the same hour; and the
// default runner module gives the supervisor the hourly check and the run's
// end hook.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumExecutable, playwrightBrowsersPath } from '../browser-server.ts';
import { staticGates, testsEnvironment } from './app-gates.ts';
import { appPaths, checkoutAt } from './app-paths.ts';
import { studioEnvironment } from './app-start.ts';
import { Aborted, hostRunner, type Run } from './exec.ts';
import { runHourlyCheck } from './hourly-check.ts';
import { lockfileProblems } from './lockfile.ts';
import { loadRunner } from './runner-module.ts';
import { servedEnvironment } from './served.ts';
import { runEnd } from './session-runner.ts';
import { hourlyCheck } from './hourly-check.ts';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('an aborted runner', () => {
  test('kills the command and what it started, and refuses to start once aborted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-abort-'));
    const controller = new AbortController();
    const run = hostRunner(dir, controller.signal);
    const pidFile = join(dir, 'grandchild.pid');
    const running = run({ command: '/bin/sh', args: ['-c', `sleep 300 & echo $! > ${pidFile}; wait`], cwd: dir, timeoutMs: 60_000 });
    let grandchild = 0;
    for (let tries = 0; tries < 100 && grandchild === 0; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      grandchild = Number(readFileSync(pidFile, { encoding: 'utf8', flag: 'a+' }).trim() || 0);
    }
    expect(isAlive(grandchild)).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.code).not.toBe(0);
    for (let tries = 0; tries < 50 && isAlive(grandchild); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isAlive(grandchild)).toBe(false);
    await expect(run({ command: 'true', args: [], cwd: dir, timeoutMs: 1000 })).rejects.toThrow(Aborted);
  });
});

describe('the run\'s tools in the check', () => {
  const ffmpeg = '/f/run.host/tools/ffmpeg';

  test('the tests gate runs with the run\'s ffmpeg, Playwright\'s browsers and the Chromium in them', async () => {
    const runs: Run[] = [];
    const runner = async (run: Run) => {
      runs.push(run);
      return { code: 0, output: '', timedOut: false };
    };
    await staticGates(runner, checkoutAt('/w/tree'), { astGrep: '/f/run.host/tools/ast-grep', ffmpeg });
    const tests = runs.find((run) => run.command === 'bun' && run.args[0] === 'test');
    const chrome = chromiumExecutable(playwrightBrowsersPath());
    expect(chrome !== undefined && existsSync(chrome)).toBe(true);
    expect(tests?.env).toEqual({ FFMPEG_BIN: ffmpeg, FFMPEG_PATH: ffmpeg, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(), CHROME_PATH: chrome ?? '' });
  });

  test('without an ffmpeg or a Chromium, the tests gate names neither', () => {
    const empty = mkdtempSync(join(tmpdir(), 'factory-browsers-'));
    expect(testsEnvironment({ astGrep: '/x' }, empty)).toEqual({ PLAYWRIGHT_BROWSERS_PATH: empty });
  });

  test('the check\'s Studio and the served copy get the run\'s ffmpeg', () => {
    const studio = studioEnvironment({ checkout: checkoutAt('/w/tree'), ffmpeg });
    expect(studio).toMatchObject({ FFMPEG_BIN: ffmpeg, FFMPEG_PATH: ffmpeg });
    expect(studioEnvironment({ checkout: checkoutAt('/w/tree') })).not.toHaveProperty('FFMPEG_BIN');
    expect(servedEnvironment(ffmpeg, { PATH: '/bin' })).toMatchObject({ FFMPEG_BIN: ffmpeg, FFMPEG_PATH: ffmpeg });
    expect(servedEnvironment(undefined, { PATH: '/bin' })).not.toHaveProperty('FFMPEG_BIN');
  });
});

describe('lockfileProblems', () => {
  test('names git, URL and file sources, and passes registry versions and the repo\'s own links', () => {
    const lock = [
      '"packages": {',
      '  "zod": ["zod@3.24.1", "", {}, "sha512-x"],',
      '  "@scope/pkg": ["@scope/pkg@1.0.0", "", {}, "sha512-y"],',
      '  "mdmedia": ["mdmedia@link:.", {}],',
      '  "evil": ["evil@github:someone/evil#main", {}],',
      '  "@scope/tar": ["@scope/tar@https://example.com/tar.tgz", {}],',
      '  "local": ["local@file:../outside", {}],',
      '  "gitdep": ["gitdep@git+ssh://git@example.com/x.git", {}],',
      '}',
    ].join('\n');
    expect(lockfileProblems(lock)).toEqual([
      'evil: evil@github:someone/evil#main',
      '@scope/tar: @scope/tar@https://example.com/tar.tgz',
      'local: local@file:../outside',
      'gitdep: gitdep@git+ssh://git@example.com/x.git',
    ]);
  });
});

describe('a check that throws', () => {
  test('writes a failed result in a fresh folder and points hour-<n> and latest at it, keeping the earlier one', async () => {
    const runDir = join(mkdtempSync(join(tmpdir(), 'factory-throw-')), 'run');
    mkdirSync(join(runDir, 'app'), { recursive: true });
    const paths = appPaths(runDir);
    const context = { runDir, appDir: join(runDir, 'app'), hour: 3, signal: new AbortController().signal };
    const first = await runHourlyCheck(context, { say: () => {} });
    expect(first.passed).toBe(false);
    expect(first.summary).toContain('app.json is missing');
    const record = JSON.parse(readFileSync(join(first.resultDir, 'result.json'), 'utf8')) as { passed: boolean; error?: string };
    expect(record.passed).toBe(false);
    expect(record.error).toContain('run factory-setup first');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runHourlyCheck(context, { say: () => {} });
    expect(second.resultDir).not.toBe(first.resultDir);
    expect(readFileSync(join(first.resultDir, 'result.json'), 'utf8')).toContain('"hour": 3');
    expect(join(paths.checks, readlinkSync(paths.latest))).toBe(second.resultDir);
    expect(join(paths.checks, readlinkSync(join(paths.checks, 'hour-3')))).toBe(second.resultDir);
  });
});

describe('the default runner module', () => {
  test('exports the hourly check and the run\'s end hook', async () => {
    const runner = await loadRunner();
    expect(runner.hourlyCheck).toBe(hourlyCheck);
    expect(runner.runEnd).toBe(runEnd);
  });
});
