import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppProcess, AppRun } from './driver.ts';
import { runCommand } from './install.ts';
import { decodeExitStatus, describeGroupProcesses, describeProcState, describeUnreapedExit, liveGroupMembers, parseProcStat, unreapedExit, watchUnreapedExit, type ProcStat } from './unreaped-exit.ts';

const onLinux = process.platform === 'linux';
const parents: ChildProcess[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) parent.kill('SIGKILL');
});

/** How long a test waits for /proc to show a process it started in the state it needs; a loaded machine can be slow to run it. */
const PROC_WAIT_MS = 4000;

/** What /proc/<pid>/stat says about `pid`, or undefined once it is gone. */
function procStat(pid: number): ProcStat | undefined {
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Polls `find` every 50ms until it returns a value, and throws `failure()` after PROC_WAIT_MS. */
async function waitForProc<T>(find: () => T | undefined, failure: () => string): Promise<T> {
  const deadline = performance.now() + PROC_WAIT_MS;
  for (let found = find(); ; found = find()) {
    if (found !== undefined) return found;
    if (performance.now() > deadline) throw new Error(`${failure()} after ${PROC_WAIT_MS}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The pids whose /proc/<pid>/stat names `parent` as their parent. */
function childrenOf(parent: number): number[] {
  const pids = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number);
  return pids.filter((pid) => procStat(pid)?.parent === parent);
}

/**
 * A real zombie: a child that has exited with `code` and that nobody reaps.
 * Its parent, `sh`, starts it in the background and then becomes `sleep`,
 * which never calls waitpid, the way the runner never reaped its children in
 * #1274. No builtin runs between the two: dash reaps an exited background
 * child after each builtin, so an `echo $!` there lost the zombie whenever the
 * child exited first (#1281). Resolves to the zombie's pid once
 * /proc/<pid>/stat shows state Z, which the kernel sets after the exit
 * status (field 52), and throws if that takes longer than PROC_WAIT_MS. It
 * reads /proc itself, not through `unreapedExit`, so a fault there fails the
 * test's assertion, not this setup.
 */
async function zombie(code: number): Promise<number> {
  const parent = spawn('sh', ['-c', `(exit ${code}) & exec sleep 60`], { stdio: 'ignore' });
  parents.push(parent);
  const parentPid = parent.pid ?? 0;
  const findZombie = () => childrenOf(parentPid).find((pid) => procStat(pid)?.state === 'Z');
  return waitForProc(findZombie, () => `no zombie child of pid ${parentPid}${describeProcState(parentPid)}`);
}

/** A child handle for an existing pid that never emits exit or close, as Bun's did. */
function silentHandle(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid });
  return child;
}

describe('reading an unreaped exit from /proc', () => {
  test('the fields come from their places after the command name, whatever the name holds', () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index));
    fields[0] = 'Z';
    fields[49] = String(3 << 8);
    expect(parseProcStat(`1234 (node (a) b) ${fields.join(' ')}`)).toEqual({ comm: 'node (a) b', state: 'Z', parent: 1, group: 2, wchan: 32, exitStatus: 768 });
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
  }, 10_000);

  /** A zombie's stat line: wchan 1 when the reader may see its exit status, 0 when ptrace access hides it. */
  const zombieLine = (exitStatus: number, visible: boolean) => {
    const fields = Array.from({ length: 50 }, () => '0');
    fields[0] = 'Z';
    fields[32] = visible ? '1' : '0';
    fields[49] = String(exitStatus);
    return `42 (node) ${fields.join(' ')}`;
  };

  test('a zombie leader thread whose other threads still run has not exited', () => {
    const line = zombieLine(0, true);
    expect(unreapedExit(42, () => line, () => 4)).toBeUndefined();
    expect(unreapedExit(42, () => line, () => 1)).toEqual({ code: 0, signal: null });
  });

  test('an exit status /proc hides (no ptrace access, shown as 0) is unknown, not success', () => {
    const exit = unreapedExit(42, () => zombieLine(0, false), () => 1);
    expect(exit).toEqual({ code: null, signal: null, unknown: true });
    expect(describeUnreapedExit('npm', exit ?? { code: null, signal: null })).toContain('would not show its exit status (no ptrace access), so it counts as failed');
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
  }, 10_000);
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
  }, 15_000);

  test.if(onLinux)('a command the runner never sees exit resolves with its exit code', async () => {
    const pid = await zombie(0);
    const result = await Promise.race([
      runCommand('npm', ['install'], { cwd: '.', spawnChild: () => silentHandle(pid) }),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 6000)),
    ]);
    expect(result).toEqual({ code: 0, output: expect.stringContaining('the runner never reaped it') });
  }, 15_000);
});

describe('a child whose exit came without its close', () => {
  const holderFiles: string[] = [];
  afterEach(() => {
    for (const file of holderFiles.splice(0)) {
      let pid = 0;
      try { pid = Number(readFileSync(file, 'utf8').trim()); } catch { continue; }
      // 0 or 1 would mean this test's own group, or init.
      const isHolder = Number.isInteger(pid) && pid > 1;
      if (!isHolder) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  /** A shell that leaves `sleep 30` in its process group holding its pipes, records that sleep's pid in a file, then exits with `code`. */
  function leavesPipesOpen(code: number): { script: string; holder: () => number } {
    const file = join(mkdtempSync(join(tmpdir(), 'pyric-holder-')), 'pid');
    holderFiles.push(file);
    return { script: `sleep 30 & echo $! > ${file}; exit ${code}`, holder: () => Number(readFileSync(file, 'utf8').trim()) };
  }

  const isAlive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  test.if(onLinux)('a process it started that still holds its pipes is named, and fails the app unless expected', async () => {
    const holder = leavesPipesOpen(4);
    const child = new AppProcess('pipe holder', 'sh', ['-c', holder.script], '.', { PATH: process.env.PATH });
    const code = await Promise.race([child.exited, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 11000))]);
    expect(code).toBe(4);
    expect(child.output).toContain(`processes it started still run in its group, holding its output pipes: pid ${holder.holder()} (sleep)`);
    expect(child.leftoverProcesses).toEqual([{ pid: holder.holder(), comm: 'sleep' }]);
    // Stopping it ends what it left in its group: SIGTERM, then SIGKILL.
    await child.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(holder.holder())).toBe(false);
  }, 25_000);

  test.if(onLinux)('the app fails on a leftover its scenario did not expect, and passes when it did', async () => {
    const run = new AppRun('leftovers', '.', tmpdir(), async () => { throw new Error('no browser'); });
    const holder = leavesPipesOpen(0);
    const result = await run.command('sh', ['-c', holder.script], { timeoutMs: 15_000 });
    expect(result.code).toBe(0);
    const [left] = run.unexpectedLeftoverProcesses();
    expect(left).toMatch(new RegExp(`^pid ${holder.holder()} \\(sleep\\), started by command 1`));
    run.expectLeftoverProcess(/^sleep$/);
    expect(run.unexpectedLeftoverProcesses()).toEqual([]);
    await run.close();
  }, 25_000);

  test.if(onLinux)('with nothing left in its group, the runner lost close, and the exit counts', async () => {
    // A child handle that reports `exit` and never `close`, for a process that is gone.
    const gone = spawn('true');
    await new Promise((resolve) => gone.once('exit', resolve));
    const handle = silentHandle(gone.pid ?? 0);
    const child = new AppProcess('lost close', 'node', ['server.mjs'], '.', {}, () => {
      setTimeout(() => handle.emit('exit', 0, null), 10);
      return handle;
    });
    expect(await Promise.race([child.exited, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 11000))])).toBe(0);
    expect(child.output).toContain('no process is left in its group, so the runner lost `close`');
    expect(child.leftoverProcesses).toEqual([]);
  }, 25_000);

  test.if(onLinux)('a command resolves with its exit code, and the process it left holding its pipes is ended', async () => {
    const holder = leavesPipesOpen(0);
    const result = await Promise.race([
      runCommand('sh', ['-c', holder.script], { cwd: '.' }),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 11000)),
    ]) as { code: number; output: string } | string;
    expect(typeof result).toBe('object');
    if (typeof result === 'string') return;
    expect(result.code).toBe(0);
    expect(result.output).toContain(`pid ${holder.holder()} (sleep)`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(isAlive(holder.holder())).toBe(false);
  }, 25_000);

  test.if(onLinux)('the group members are the live processes in it, zombies left out', async () => {
    const holder = leavesPipesOpen(0);
    const parent = spawn('sh', ['-c', holder.script], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => parent.once('exit', resolve));
    // The holder is a fork of sh until it execs sleep, and /proc names it sh until then.
    const holderPid = holder.holder();
    await waitForProc(() => (procStat(holderPid)?.comm === 'sleep' ? true : undefined), () => `pid ${holderPid} did not become sleep${describeProcState(holderPid)}`);
    const members = liveGroupMembers(parent.pid ?? 0);
    expect(members).toEqual([{ pid: holderPid, comm: 'sleep' }]);
  });
});

describe('naming what a stopped command was running (#1476)', () => {
  /** A /proc/<pid>/stat line with the fields the driver reads and zeros for the rest. */
  const statLine = (pid: number, comm: string, state: string, parent: number, group: number) =>
    `${pid} (${comm}) ${state} ${parent} ${group} ${Array.from({ length: 48 }, () => '0').join(' ')}`;
  const stats = new Map([
    [100, statLine(100, 'npm install', 'S', 1, 100)],
    [101, statLine(101, 'sh', 'S', 100, 100)],
    [102, statLine(102, 'node', 'S', 101, 100)],
    [200, statLine(200, 'node', 'R', 1, 200)],
  ]);
  const cmdlines = new Map([
    [100, 'npm install --prefer-offline'],
    [101, 'sh -c prebuild-install || node-gyp rebuild'],
  ]);
  const describe100 = () => describeGroupProcesses(100, (pid) => stats.get(pid), () => [...stats.keys()], (pid) => cmdlines.get(pid));

  test.if(onLinux)('each process in the group gets its pid, parent, state and command line; other groups are left out', () => {
    expect(describe100().split('\n')).toEqual([
      'pid 100 parent 1 state S: npm install --prefer-offline',
      'pid 101 parent 100 state S: sh -c prebuild-install || node-gyp rebuild',
      'pid 102 parent 101 state S: (node)',
    ]);
  });

  test.if(onLinux)('a group with no process left reads as none', () => {
    expect(describeGroupProcesses(300, (pid) => stats.get(pid), () => [...stats.keys()], () => undefined)).toBe('(none)');
  });
});
