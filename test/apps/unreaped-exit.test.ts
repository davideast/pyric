import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AppProcess } from './driver.ts';
import { runCommand } from './install.ts';
import { decodeExitStatus, parseProcStat, unreapedExit, watchUnreapedExit } from './unreaped-exit.ts';

const onLinux = process.platform === 'linux';
const parents: ChildProcess[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) parent.kill('SIGKILL');
});

/**
 * A real zombie: a child that has exited with `code` and that nobody reaps.
 * Its parent, `sh`, starts it in the background and then becomes `sleep`,
 * which never calls waitpid, the way the runner never reaped its children in
 * #1274. Resolves to the zombie's pid once it has exited.
 */
async function zombie(code: number): Promise<number> {
  const parent = spawn('sh', ['-c', `(exit ${code}) & echo $!; exec sleep 60`], { stdio: ['ignore', 'pipe', 'ignore'] });
  parents.push(parent);
  const pid = await new Promise<number>((resolve) => {
    parent.stdout?.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
  for (let tries = 0; tries < 50 && unreapedExit(pid) === undefined; tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  return pid;
}

/** A child handle for an existing pid that never emits exit or close, as Bun's did. */
function silentHandle(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid });
  return child;
}

describe('reading an unreaped exit from /proc', () => {
  test('the state and exit status come from fields 3 and 52, whatever the command name holds', () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index));
    fields[0] = 'Z';
    fields[49] = String(3 << 8);
    expect(parseProcStat(`1234 (node (a) b) ${fields.join(' ')}`)).toEqual({ state: 'Z', exitStatus: 768 });
    expect(parseProcStat('1234 (short) S 1 2')).toBeUndefined();
  });

  test('a waitpid status gives an exit code, or the signal that ended the child', () => {
    expect(decodeExitStatus(3 << 8)).toEqual({ code: 3, signal: null });
    expect(decodeExitStatus(0)).toEqual({ code: 0, signal: null });
    expect(decodeExitStatus(9)).toEqual({ code: null, signal: 9 });
  });

  test.if(onLinux)('a running process has no exit, and a zombie has its own', async () => {
    expect(unreapedExit(process.pid)).toBeUndefined();
    expect(unreapedExit(await zombie(3))).toEqual({ code: 3, signal: null });
  });

  test('a zombie leader thread whose other threads still run has not exited', () => {
    const fields = Array.from({ length: 50 }, () => '0');
    fields[0] = 'Z';
    const line = `42 (node) ${fields.join(' ')}`;
    expect(unreapedExit(42, () => line, () => 4)).toBeUndefined();
    expect(unreapedExit(42, () => line, () => 1)).toEqual({ code: 0, signal: null });
  });

  test.if(onLinux)('a zombie counts as missed only once it outlasts the grace period', async () => {
    const pid = await zombie(5);
    const seen: number[] = [];
    const started = performance.now();
    const stop = watchUnreapedExit(pid, (exit) => seen.push(exit.code ?? -1, performance.now() - started), { intervalMs: 50, graceMs: 600 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(seen).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 700));
    stop();
    expect(seen[0]).toBe(5);
    expect(seen[1]).toBeGreaterThanOrEqual(600);
  });
});

describe('the driver sees a child that exited unreaped', () => {
  test('a child that exits normally settles from its close, with all its output, never from /proc', async () => {
    const child = new AppProcess('normal', 'node', ['-e', 'console.log("last line")'], '.', { PATH: process.env.PATH });
    expect(await child.exited).toBe(0);
    expect(child.output).toContain('last line');
    expect(child.output).not.toContain('never reaped');
  });

  test.if(onLinux)('an app process whose exit never arrives settles with the zombie\'s exit code, after the grace period', async () => {
    const pid = await zombie(3);
    const child = new AppProcess('never reaped', 'node', ['server.mjs'], '.', {}, () => silentHandle(pid));
    const code = await Promise.race([child.exited, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 6000))]);
    expect(code).toBe(3);
    expect(child.running).toBe(false);
    expect(child.output).toContain('exited with code 3, and the runner never reaped it');
  }, 10_000);

  test.if(onLinux)('a command the runner never sees exit resolves with its exit code', async () => {
    const pid = await zombie(0);
    const result = await Promise.race([
      runCommand('npm', ['install'], { cwd: '.', spawnChild: () => silentHandle(pid) }),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 6000)),
    ]);
    expect(result).toEqual({ code: 0, output: expect.stringContaining('the runner never reaped it') });
  }, 10_000);
});
