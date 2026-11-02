// The check's plumbing: an aborted runner ends its whole process group; a
// lockfile naming a source other than the registry is named; a check that
// throws still writes a failed result and points `latest` and `hour-<n>` at
// it, in a fresh folder that keeps an earlier run of the same hour; and the
// default runner module gives the supervisor the hourly check and the run's
// end hook.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appPaths } from './app-paths.ts';
import { Aborted, hostRunner } from './exec.ts';
import { runHourlyCheck } from './hourly-check.ts';
import { lockfileProblems } from './lockfile.ts';
import { loadRunner } from './runner-module.ts';
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
