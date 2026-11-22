import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppProcess } from './driver.ts';
import { collectDescendantGroups, hasLiveGroupProcesses } from './process-reaper.ts';

const spawnedGroups: number[] = [];
afterEach(() => {
  for (const group of spawnedGroups.splice(0)) {
    if (group <= 1) continue;
    try {
      process.kill(-group, 'SIGKILL');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') throw error;
    }
  }
});

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitUntilDead(pid: number, timeoutMs = 4_000): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (isPidAlive(pid)) {
    if (performance.now() >= deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 40));
  }
  return true;
}

function statLine(pid: number, comm: string, state: string, parent: number, group: number): string {
  return `${pid} (${comm}) ${state} ${parent} ${group} ${Array.from({ length: 48 }, () => '0').join(' ')}`;
}

describe('descendant process group discovery (#1484)', () => {
  test('collects detached child and grandchild groups while excluding init and the runner group', () => {
    const runnerPid = process.pid;
    const runnerGroup = 9000;
    const stats = new Map<number, string>([
      [runnerPid, statLine(runnerPid, 'bun', 'R', 1, runnerGroup)],
      [100, statLine(100, 'node', 'Z', runnerPid, 100)],
      [200, statLine(200, 'next-server', 'S', 100, 200)],
      [201, statLine(201, 'postcss', 'S', 200, 300)],
      [400, statLine(400, 'unrelated', 'S', 1, 400)],
    ]);
    const into = new Set<number>();
    collectDescendantGroups(100, into, (pid) => stats.get(pid), () => [...stats.keys()]);
    expect([...into].sort((a, b) => a - b)).toEqual([200, 300]);
    expect(hasLiveGroupProcesses(into, (pid) => stats.get(pid), () => [...stats.keys()])).toBe(true);
    expect(hasLiveGroupProcesses(new Set([100]), (pid) => stats.get(pid), () => [...stats.keys()])).toBe(false);
  });
});

describe('stopping escaped subgroups and orphaned scenario runners (#1484)', () => {
  test.if(process.platform === 'linux')('AppProcess.stop() reaps a detached grandchild group when the leader ignores SIGTERM', async () => {
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      "const grand = spawn('node', ['-e', 'setInterval(() => {}, 30000)'], { detached: true, stdio: 'ignore' });",
      'grand.unref();',
      "process.stdout.write('GRAND:' + grand.pid + '\\n');",
      'setInterval(() => {}, 30000);',
    ].join('\n');
    const proc = new AppProcess('fake-sandbox', 'node', ['-e', parentScript], '.', { PATH: process.env.PATH });
    if (proc.pid !== undefined) spawnedGroups.push(proc.pid);
    const match = await proc.waitForLog(/^GRAND:(\d+)$/m, { timeoutMs: 5_000 });
    const grandPid = Number(match[1]);
    spawnedGroups.push(grandPid);

    await proc.stop({ termMs: 200, killMs: 200 });

    expect(await waitUntilDead(grandPid)).toBe(true);
    if (proc.pid !== undefined) {
      expect(await waitUntilDead(proc.pid)).toBe(true);
    }
  }, 15_000);

  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    test(`killing a scenario runner with ${signal} reaps its detached AppProcess and subgroup`, async () => {
      const driverHref = pathToFileURL(resolve(import.meta.dir, 'driver.ts')).href;
      const runnerCode = [
        `const { AppProcess } = await import(${JSON.stringify(driverHref)});`,
        "const inner = \"const { spawn } = require('node:child_process'); const g = spawn('node', ['-e', 'setInterval(() => {}, 30000)'], { detached: true, stdio: 'ignore' }); g.unref(); process.stdout.write('SUB:' + g.pid + '\\\\n'); setInterval(() => {}, 30000);\";",
        "const appProc = new AppProcess('fake-dev', 'node', ['-e', inner], '.', { PATH: process.env.PATH });",
        'const m = await appProc.waitForLog(/^SUB:(\\d+)$/m, { timeoutMs: 5000 });',
        "process.stdout.write(JSON.stringify({ appPid: appProc.pid, subPid: Number(m[1]) }) + '\\n');",
        'setInterval(() => {}, 30000);',
      ].join('\n');

      const runner = spawn('bun', ['-e', runnerCode], {
        cwd: resolve(import.meta.dir, '../..'),
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let line = '';
      runner.stdout.setEncoding('utf8');
      const reported = await new Promise<{ appPid: number; subPid: number }>((resolvePids, reject) => {
        runner.once('error', reject);
        runner.stdout.on('data', (chunk: string) => {
          line += chunk;
          const nl = line.indexOf('\n');
          if (nl !== -1) {
            resolvePids(JSON.parse(line.slice(0, nl)) as { appPid: number; subPid: number });
          }
        });
      });
      spawnedGroups.push(reported.appPid, reported.subPid);

      runner.kill(signal);
      await new Promise((resolveExit) => runner.once('exit', resolveExit));

      expect(await waitUntilDead(reported.appPid)).toBe(true);
      expect(await waitUntilDead(reported.subPid)).toBe(true);
    }, 15_000);
  }

  test('the exit reaper pipe does not hold a normal runner process open after its child stops', async () => {
    const driverHref = pathToFileURL(resolve(import.meta.dir, 'driver.ts')).href;
    const runnerCode = [
      `const { AppProcess } = await import(${JSON.stringify(driverHref)});`,
      "const appProc = new AppProcess('one-shot', 'node', ['-e', 'process.exit(0)'], '.', { PATH: process.env.PATH });",
      'await appProc.exited;',
      'process.stdout.write(String(Date.now()));',
    ].join('\n');

    const child = spawn('bun', ['-e', runnerCode], {
      cwd: resolve(import.meta.dir, '../..'),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    const exitedAt = await new Promise<number>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolveExit(Date.now()));
    });
    const endedAt = Number(out.trim());
    expect(Number.isFinite(endedAt)).toBe(true);
    expect(exitedAt - endedAt).toBeLessThan(1_500);
  }, 15_000);
});
