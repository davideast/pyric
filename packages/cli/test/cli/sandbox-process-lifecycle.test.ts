/**
 * Process lifecycle regression suite for `pyric sandbox` and its spawned child
 * command (#1775, #1677, #1551, #1195):
 *  - Unit coverage for `sandbox-process-guard.ts` and `sandbox-child-lifeline.ts`.
 *  - Subprocess coverage against `dist/cli/index.js` verifying `SIGKILL` stops
 *    the child group and frees ports (#1775), killing the child stops the host
 *    without CPU spin (#1677), closed output pipes never spin on `EPIPE` (#1195),
 *    and parent loss / `SIGTERM` shuts orphaned sandboxes down cleanly (#1551).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  readLinuxProcessStartTime,
  startChildLifeline,
} from '../../src/cli/sandbox-child-lifeline.js';
import {
  formatShellCommand,
  spawnDevChild,
  spawnSandboxChild,
  type DevChildHandle,
  type DevChildPlan,
} from '../../src/cli/sandbox-runner.js';
import {
  flushStandardStreamsBeforeExit,
  installOutputPipeGuard,
  installServeProcessGuard,
  isBrokenOutputPipeError,
  watchParentLoss,
  writeStreamQuietly,
  type GuardedWritableStream,
} from '../../src/cli/sandbox-process-guard.js';

const cliRoot = resolve(import.meta.dir, '../..');
const cliEntry = join(cliRoot, 'dist/cli/index.js');
const CLOCK_TICKS_PER_SECOND = 100;
const posixOnly = process.platform !== 'win32' ? describe : describe.skip;
const linuxOnly = process.platform === 'linux' ? describe : describe.skip;

const tempDirs: string[] = [];
const trackedPids = new Set<number>();

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code;
}

function killSafe(pid: number, sig: NodeJS.Signals | 0): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH') || isErrno(error, 'EPERM')) return false;
    throw error;
  }
}

function forceKillPidAndGroup(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return;
  killSafe(-pid, 'SIGKILL');
  killSafe(pid, 'SIGKILL');
}

type LinuxProcStat = { state: string; ticks: number; numThreads: number };

function parseLinuxStat(raw: string): LinuxProcStat | null {
  const closeParen = raw.lastIndexOf(')');
  if (closeParen === -1) return null;
  const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
  const state = fields[0];
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  const numThreads = Number(fields[17]);
  if (state === undefined || !Number.isFinite(utime) || !Number.isFinite(stime) || !Number.isFinite(numThreads)) return null;
  return { state, ticks: utime + stime, numThreads };
}

function isLinuxStatAlive(stat: LinuxProcStat): boolean {
  // In Linux do_group_exit(), leader state hits 'Z' before sibling threads finish exit_files().
  if (stat.numThreads > 1) return true;
  return stat.state !== 'Z' && stat.state !== 'X';
}

function readLinuxStat(pid: number): LinuxProcStat | null {
  if (process.platform !== 'linux') return null;
  try {
    return parseLinuxStat(readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ESRCH') || isErrno(error, 'EACCES')) return null;
    throw error;
  }
}

function isRunning(pid: number): boolean {
  if (!killSafe(pid, 0)) return false;
  const stat = readLinuxStat(pid);
  if (stat === null) return process.platform !== 'linux';
  return isLinuxStatAlive(stat);
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<{ gone: boolean; cpuTicks: number }> {
  const startTicks = readLinuxStat(pid)?.ticks ?? 0;
  let lastTicks = startTicks;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stat = readLinuxStat(pid);
    if (stat !== null) lastTicks = stat.ticks;
    if (!isRunning(pid)) {
      return { gone: true, cpuTicks: Math.max(0, lastTicks - startTicks) };
    }
    await Bun.sleep(40);
  }
  const finalStat = readLinuxStat(pid);
  if (finalStat !== null) lastTicks = finalStat.ticks;
  return { gone: !isRunning(pid), cpuTicks: Math.max(0, lastTicks - startTicks) };
}

async function freeLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const srv = createServer();
    srv.once('error', rejectPort);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function canBindPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolveBind) => {
    const srv = createServer();
    srv.once('error', () => resolveBind(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolveBind(true));
    });
  });
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBindPort(port)) return true;
    await Bun.sleep(40);
  }
  return await canBindPort(port);
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(400) });
      await res.arrayBuffer();
      if (res.ok) return true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    await Bun.sleep(60);
  }
  return false;
}

function fakeStream(options: {
  destroyed?: boolean;
  writableEnded?: boolean;
  writable?: boolean;
  throwOnWrite?: Error;
  stallCallback?: boolean;
} = {}): GuardedWritableStream & EventEmitter & { chunks: string[] } {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  return Object.assign(emitter, {
    chunks,
    destroyed: options.destroyed ?? false,
    writableEnded: options.writableEnded ?? false,
    writable: options.writable ?? true,
    write(chunk: string, callback?: (error?: Error | null) => void): boolean {
      if (options.throwOnWrite !== undefined) {
        throw options.throwOnWrite;
      }
      chunks.push(chunk);
      if (options.stallCallback !== true) {
        callback?.(null);
      }
      return true;
    },
  });
}

afterEach(() => {
  for (const pid of [...trackedPids]) {
    forceKillPidAndGroup(pid);
    trackedPids.delete(pid);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('sandbox-process-guard unit', () => {
  it('identifies broken output pipe error codes and stream-destroyed messages', () => {
    for (const code of ['EPIPE', 'EIO', 'EBADF', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']) {
      const err = Object.assign(new Error(`write ${code}`), { code });
      expect(isBrokenOutputPipeError(err)).toBe(true);
    }
    expect(isBrokenOutputPipeError(new Error('write EPIPE'))).toBe(true);
    expect(isBrokenOutputPipeError(new Error('ordinary bug'))).toBe(false);
    expect(isBrokenOutputPipeError(null)).toBe(false);
  });

  it('absorbs broken-pipe stream error events and stops writing to broken streams', () => {
    const out = fakeStream();
    const uninstall = installOutputPipeGuard([out]);
    try {
      writeStreamQuietly(out, 'before\n');
      expect(out.chunks).toEqual(['before\n']);
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
      expect(() => out.emit('error', epipe)).not.toThrow();
      writeStreamQuietly(out, 'after\n');
      expect(out.chunks).toEqual(['before\n']);
    } finally {
      uninstall();
    }
  });

  it('drops broken-pipe uncaught errors and prevents re-entrant logger feedback loops', () => {
    const emitter = new EventEmitter();
    const proc = {
      on: (event: string, cb: (...args: unknown[]) => void) => {
        emitter.on(event, cb);
        return emitter as unknown as NodeJS.Process;
      },
      off: (event: string, cb: (...args: unknown[]) => void) => {
        emitter.off(event, cb);
        return emitter as unknown as NodeJS.Process;
      },
    } as Pick<NodeJS.Process, 'on' | 'off'>;

    let calls = 0;
    const uninstall = installServeProcessGuard(() => {
      calls += 1;
      // Simulate logger hitting a broken stderr pipe that re-emits uncaughtException.
      emitter.emit('uncaughtException', new Error('nested logger failure'));
      throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    }, proc);

    try {
      emitter.emit('uncaughtException', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      emitter.emit('unhandledRejection', Object.assign(new Error('destroyed'), { code: 'ERR_STREAM_DESTROYED' }));
      expect(calls).toBe(0);

      emitter.emit('uncaughtException', new Error('real application failure'));
      expect(calls).toBe(1);
    } finally {
      uninstall();
    }
  });

  it('watches parent PID changes and literal ppid === 1 and fires once when reparented', async () => {
    let currentPpid = 4242;
    let orphanedCount = 0;
    const stop = watchParentLoss(
      () => {
        orphanedCount += 1;
      },
      { initialPpid: 4242, readPpid: () => currentPpid, intervalMs: 15 },
    );
    try {
      await Bun.sleep(40);
      expect(orphanedCount).toBe(0);
      currentPpid = 1;
      await Bun.sleep(50);
      expect(orphanedCount).toBe(1);
    } finally {
      stop();
    }

    let literalInitCount = 0;
    const stopInit = watchParentLoss(
      () => {
        literalInitCount += 1;
      },
      { initialPpid: 1, readPpid: () => 1, intervalMs: 15 },
    );
    try {
      await Bun.sleep(20);
      expect(literalInitCount).toBe(1);
    } finally {
      stopInit();
    }
  });

  it('flushes healthy streams, skips destroyed streams, and bounds stalled streams before exit', async () => {
    let exitedWith: number | null = null;
    const healthy = fakeStream();
    const destroyed = fakeStream({ destroyed: true });
    flushStandardStreamsBeforeExit(0, (code) => { exitedWith = code; }, [healthy, destroyed], 200);
    expect(exitedWith).toBe(0);
    expect(healthy.chunks).toEqual(['']);
    expect(destroyed.chunks).toEqual([]);

    let stalledExit: number | null = null;
    const stalled = fakeStream({ stallCallback: true });
    flushStandardStreamsBeforeExit(2, (code) => { stalledExit = code; }, [stalled], 40);
    await Bun.sleep(90);
    expect(stalledExit).toBe(2);
  });

  it('preserves sandbox-runner compatibility aliases', () => {
    const plan: DevChildPlan = { argv: ['node', 'server.mjs'], label: 'node server.mjs' };
    const readExit = (handle: DevChildHandle): Promise<number> => handle.exited;
    expect(formatShellCommand(plan.argv)).toBe('node server.mjs');
    expect(spawnDevChild).toBe(spawnSandboxChild);
    expect(typeof readExit).toBe('function');
  });

  it('treats zombie leaders with live sibling threads as running and fails waitForPortFree on held ports', async () => {
    const mkStat = (state: string, threads: number): string =>
      `100 (node) ${state} 1 100 100 0 -1 0 0 0 0 0 5 3 0 0 20 0 ${threads} 0 999`;
    const tearingDown = parseLinuxStat(mkStat('Z', 2));
    const zombieAlone = parseLinuxStat(mkStat('Z', 1));
    expect(tearingDown !== null && isLinuxStatAlive(tearingDown)).toBe(true);
    expect(zombieAlone !== null && isLinuxStatAlive(zombieAlone)).toBe(false);

    const heldPort = await freeLoopbackPort();
    const holder = createServer();
    await new Promise<void>((r) => holder.listen(heldPort, '127.0.0.1', () => r()));
    try {
      expect(await waitForPortFree(heldPort, 100)).toBe(false);
    } finally {
      await new Promise<void>((r) => holder.close(() => r()));
    }
    expect(await waitForPortFree(heldPort, 500)).toBe(true);
  });
});

posixOnly('sandbox-child-lifeline unit', () => {
  it('reads Linux /proc starttime when on Linux and disarms cleanly on normal child exit', async () => {
    if (process.platform === 'linux') {
      expect(readLinuxProcessStartTime(process.pid)).toMatch(/^\d+$/);
    }
    const child = spawn('node', ['-e', 'setTimeout(() => process.exit(0), 60)'], {
      stdio: 'ignore',
      detached: true,
    });
    if (child.pid !== undefined) trackedPids.add(child.pid);
    const lifeline = startChildLifeline(child.pid);
    const code = await new Promise<number | null>((resolveExit) => {
      child.once('exit', (exitCode) => resolveExit(exitCode));
    });
    lifeline.disarm();
    expect(code).toBe(0);
  });
});

linuxOnly('pyric sandbox subprocess lifecycle (#1775, #1677, #1551, #1195)', () => {
  it('SIGKILL to pyric sandbox stops its child server and grandchild worker and frees the port (#1775)', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build @pyric/cli first: ${cliEntry}`);
    const dir = makeTempDir('pyric-proc-1775-');
    const hostPort = await freeLoopbackPort();
    const appPort = await freeLoopbackPort();
    const pidsFile = join(dir, 'pids.json');
    writeFileSync(
      join(dir, 'server.mjs'),
      [
        "import { createServer } from 'node:http';",
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "const srv = createServer((_req, res) => res.end('ok'));",
        `srv.listen(${appPort}, '127.0.0.1', () => {`,
        `  writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ childPid: process.pid, workerPid: worker.pid }));`,
        '});',
      ].join('\n'),
    );

    const cli: ChildProcess = spawn(
      'node',
      [cliEntry, 'sandbox', '--hosted', '--no-open', '--no-ui', '--host', '127.0.0.1', '--port', String(hostPort), '--', 'node', 'server.mjs'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    if (cli.pid !== undefined) trackedPids.add(cli.pid);
    cli.stdout?.on('data', () => {});
    cli.stderr?.on('data', () => {});

    expect(await waitForHttpOk(`http://127.0.0.1:${appPort}/`, 20_000)).toBe(true);
    const { childPid, workerPid } = JSON.parse(readFileSync(pidsFile, 'utf8')) as {
      childPid: number;
      workerPid: number;
    };
    trackedPids.add(childPid);
    trackedPids.add(workerPid);

    process.kill(cli.pid ?? 0, 'SIGKILL');
    const childOutcome = await waitUntilGone(childPid, 4_000);
    const workerOutcome = await waitUntilGone(workerPid, 4_000);
    expect(childOutcome.gone).toBe(true);
    expect(workerOutcome.gone).toBe(true);
    expect(await waitForPortFree(appPort, 1_500)).toBe(true);
    expect(await waitForPortFree(hostPort, 1_500)).toBe(true);
  }, 45_000);

  it('honors SIGINT and SIGTERM without CPU spin after stdout and stderr pipes close (#1195)', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build @pyric/cli first: ${cliEntry}`);
    for (const signalName of ['SIGINT', 'SIGTERM'] as const) {
      const dir = makeTempDir(`pyric-proc-1195-${signalName}-`);
      const hostPort = await freeLoopbackPort();
      const cli = spawn(
        'node',
        [cliEntry, 'sandbox', '--hosted', '--no-open', '--no-ui', '--host', '127.0.0.1', '--port', String(hostPort)],
        { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
      );
      const pid = cli.pid ?? 0;
      trackedPids.add(pid);

      expect(await waitForHttpOk(`http://127.0.0.1:${hostPort}/__pyric/health`, 20_000)).toBe(true);
      cli.stdout?.destroy();
      cli.stderr?.destroy();
      // Trigger additional host log writes while both output pipes are closed.
      await waitForHttpOk(`http://127.0.0.1:${hostPort}/__pyric/health`, 2_000);
      await Bun.sleep(200);

      process.kill(pid, signalName);
      const outcome = await waitUntilGone(pid, 4_000);
      expect(outcome.gone).toBe(true);
      expect(outcome.cpuTicks / CLOCK_TICKS_PER_SECOND).toBeLessThan(0.75);
      expect(await waitForPortFree(hostPort, 1_500)).toBe(true);
    }
  }, 45_000);

  it('exits cleanly without spinning when its child process is killed even after output pipes close (#1677)', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build @pyric/cli first: ${cliEntry}`);
    const dir = makeTempDir('pyric-proc-1677-');
    const hostPort = await freeLoopbackPort();
    const appPort = await freeLoopbackPort();
    const childPidFile = join(dir, 'child.pid');
    writeFileSync(
      join(dir, 'server.mjs'),
      [
        "import { createServer } from 'node:http';",
        "import { writeFileSync } from 'node:fs';",
        "process.on('SIGTERM', () => {",
        "  console.log('child exiting on SIGTERM');",
        '  process.exit(0);',
        '});',
        "createServer((_req, res) => res.end('ok')).listen(" + String(appPort) + ", '127.0.0.1', () => {",
        `  writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
        '});',
      ].join('\n'),
    );

    const cli = spawn(
      'node',
      [cliEntry, 'sandbox', '--no-open', '--no-ui', '--host', '127.0.0.1', '--port', String(hostPort), '--', 'node', 'server.mjs'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    const hostPid = cli.pid ?? 0;
    trackedPids.add(hostPid);

    expect(await waitForHttpOk(`http://127.0.0.1:${appPort}/`, 20_000)).toBe(true);
    const childPid = Number(readFileSync(childPidFile, 'utf8').trim());
    trackedPids.add(childPid);

    cli.stdout?.destroy();
    cli.stderr?.destroy();
    await Bun.sleep(150);

    process.kill(childPid, 'SIGTERM');
    const outcome = await waitUntilGone(hostPid, 4_000);
    expect(outcome.gone).toBe(true);
    expect(outcome.cpuTicks / CLOCK_TICKS_PER_SECOND).toBeLessThan(0.75);
  }, 45_000);

  it('shuts down when orphaned by parent death and honors SIGTERM (#1551)', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build @pyric/cli first: ${cliEntry}`);
    const dir = makeTempDir('pyric-proc-1551-');
    const hostPort = await freeLoopbackPort();
    const appPort = await freeLoopbackPort();
    const sandboxPidFile = join(dir, 'sandbox.pid');
    const childPidFile = join(dir, 'child.pid');
    writeFileSync(
      join(dir, 'server.mjs'),
      [
        "import { createServer } from 'node:http';",
        "import { writeFileSync } from 'node:fs';",
        "createServer((_req, res) => res.end('ok')).listen(" + String(appPort) + ", '127.0.0.1', () => {",
        `  writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
        '});',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'launcher.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `const p = spawn(process.execPath, [${JSON.stringify(cliEntry)}, 'sandbox', '--hosted', '--no-open', '--no-ui', '--host', '127.0.0.1', '--port', ${JSON.stringify(String(hostPort))}, '--', 'node', 'server.mjs'], { cwd: ${JSON.stringify(dir)}, stdio: ['ignore', 'pipe', 'pipe'], detached: true });`,
        `writeFileSync(${JSON.stringify(sandboxPidFile)}, String(p.pid));`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

    const launcher = spawn('node', [join(dir, 'launcher.mjs')], {
      cwd: dir,
      stdio: 'ignore',
      detached: true,
    });
    const launcherPid = launcher.pid ?? 0;
    trackedPids.add(launcherPid);

    expect(await waitForHttpOk(`http://127.0.0.1:${appPort}/`, 20_000)).toBe(true);
    const sandboxPid = Number(readFileSync(sandboxPidFile, 'utf8').trim());
    const childPid = Number(readFileSync(childPidFile, 'utf8').trim());
    trackedPids.add(sandboxPid);
    trackedPids.add(childPid);

    process.kill(launcherPid, 'SIGKILL');
    const sandboxOutcome = await waitUntilGone(sandboxPid, 4_000);
    const childOutcome = await waitUntilGone(childPid, 4_000);
    expect(sandboxOutcome.gone).toBe(true);
    expect(childOutcome.gone).toBe(true);
    expect(sandboxOutcome.cpuTicks / CLOCK_TICKS_PER_SECOND).toBeLessThan(0.75);
    expect(await waitForPortFree(hostPort, 1_500)).toBe(true);
    expect(await waitForPortFree(appPort, 1_500)).toBe(true);
  }, 45_000);

  it('reaps a SIGTERM-ignoring grandchild in the child process group when the wrapper exits early', async () => {
    if (!existsSync(cliEntry)) throw new Error(`build @pyric/cli first: ${cliEntry}`);
    const dir = makeTempDir('pyric-proc-grandchild-');
    const hostPort = await freeLoopbackPort();
    const appPort = await freeLoopbackPort();
    const pidsFile = join(dir, 'pids.json');
    writeFileSync(
      join(dir, 'grandchild.mjs'),
      [
        "process.on('SIGTERM', () => {});",
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    writeFileSync(
      join(dir, 'wrapper.mjs'),
      [
        "import { createServer } from 'node:http';",
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const grand = spawn(process.execPath, ['grandchild.mjs'], { stdio: 'ignore' });",
        "process.on('SIGTERM', () => process.exit(0));",
        `createServer((_req, res) => res.end('ok')).listen(${appPort}, '127.0.0.1', () => {`,
        `  writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ wrapperPid: process.pid, grandPid: grand.pid }));`,
        '});',
      ].join('\n'),
    );

    const cli = spawn(
      'node',
      [cliEntry, 'sandbox', '--no-open', '--no-ui', '--host', '127.0.0.1', '--port', String(hostPort), '--', 'node', 'wrapper.mjs'],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    const hostPid = cli.pid ?? 0;
    trackedPids.add(hostPid);
    cli.stdout?.on('data', () => {});
    cli.stderr?.on('data', () => {});

    expect(await waitForHttpOk(`http://127.0.0.1:${appPort}/`, 20_000)).toBe(true);
    const { wrapperPid, grandPid } = JSON.parse(readFileSync(pidsFile, 'utf8')) as {
      wrapperPid: number;
      grandPid: number;
    };
    trackedPids.add(wrapperPid);
    trackedPids.add(grandPid);

    process.kill(hostPid, 'SIGTERM');
    const hostOutcome = await waitUntilGone(hostPid, 6_000);
    const grandOutcome = await waitUntilGone(grandPid, 2_000);
    expect(hostOutcome.gone).toBe(true);
    expect(grandOutcome.gone).toBe(true);
  }, 45_000);
});
