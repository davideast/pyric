// Process lifecycle bounds for `pyric sandbox` and its child command (#1775,
// #1677, #1551, #1195):
//   1. SIGKILL to `pyric sandbox --hosted -- node server.mjs` ends the child
//      command and frees both ports so the next sandbox in the project binds
//      the same host and app ports (#1775).
//   2. Stopping only the child command by PID shuts `pyric sandbox` down
//      cleanly without spinning on CPU (#1677).
//   3. Closing `pyric sandbox`'s stdout/stderr pipes does not trigger an EPIPE
//      spin, and SIGINT/SIGTERM shuts the host down and releases its project
//      lock (#1195).
//   4. When `pyric sandbox`'s parent process dies (reparenting the sandbox),
//      the orphaned sandbox exits cleanly without spinning and honors SIGTERM
//      (#1551).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { scenario, sleep, type App } from '../driver.ts';

const CLOCK_TICKS_PER_SECOND = 100;

function isErrnoCode(error: unknown, expected: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === expected;
}

function signalProcessIfAlive(pid: number, sig: NodeJS.Signals | 0): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, sig);
    return true;
  } catch (error) {
    if (isErrnoCode(error, 'ESRCH') || isErrnoCode(error, 'EPERM')) return false;
    throw error;
  }
}

function forceCleanupPidAndGroup(pid: number | undefined): void {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1) return;
  signalProcessIfAlive(-pid, 'SIGKILL');
  signalProcessIfAlive(pid, 'SIGKILL');
}

function readProcStatFields(pid: number): { state: string; ticks: number } | null {
  if (process.platform !== 'linux') return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen === -1) return null;
    const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
    const state = fields[0];
    const utime = Number(fields[11]);
    const stime = Number(fields[12]);
    if (state === undefined || !Number.isFinite(utime) || !Number.isFinite(stime)) return null;
    return { state, ticks: utime + stime };
  } catch (error) {
    if (isErrnoCode(error, 'ENOENT') || isErrnoCode(error, 'ESRCH') || isErrnoCode(error, 'EACCES')) {
      return null;
    }
    throw error;
  }
}

function isProcessRunning(pid: number): boolean {
  if (!signalProcessIfAlive(pid, 0)) return false;
  const stat = readProcStatFields(pid);
  if (stat === null) return process.platform !== 'linux';
  return stat.state !== 'Z' && stat.state !== 'X';
}

async function waitUntilProcessGone(
  pid: number,
  timeoutMs: number,
): Promise<{ exited: boolean; peakCpuTicks: number }> {
  const baseline = readProcStatFields(pid)?.ticks ?? 0;
  let lastTicks = baseline;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stat = readProcStatFields(pid);
    if (stat !== null) lastTicks = stat.ticks;
    if (!isProcessRunning(pid)) {
      return { exited: true, peakCpuTicks: Math.max(0, lastTicks - baseline) };
    }
    await sleep(50);
  }
  const finalStat = readProcStatFields(pid);
  if (finalStat !== null) lastTicks = finalStat.ticks;
  return {
    exited: !isProcessRunning(pid),
    peakCpuTicks: Math.max(0, lastTicks - baseline),
  };
}

async function readChildHealth(port: number): Promise<{ ok: boolean; pid: number } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return null;
    return (await response.json()) as { ok: boolean; pid: number };
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

async function readChildFirestoreRoundTrip(port: number): Promise<{ ok: boolean; pid: number; status: string | null } | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return null;
    return (await response.json()) as { ok: boolean; pid: number; status: string | null };
  } catch (error) {
    if (error instanceof Error) return null;
    throw error;
  }
}

async function waitForChildListening(port: number, pidFile: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      const answer = await readChildHealth(port);
      if (Number.isInteger(pid) && pid > 1 && answer?.ok === true) {
        return pid;
      }
    }
    await sleep(100);
  }
  throw new Error(`child server on port ${port} did not start listening within ${timeoutMs}ms`);
}

async function canBindLoopbackPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canBindLoopbackPort(port)) return true;
    await sleep(50);
  }
  return await canBindLoopbackPort(port);
}

function buildIsolatedEnv(app: App, label: string): NodeJS.ProcessEnv {
  const home = join(app.dir, '.scenario-homes', label);
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    NO_COLOR: '1',
  };
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'SystemRoot', 'CI']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function spawnPackedPyric(app: App, args: string[], label: string): ChildProcess {
  const cliBin = join(app.dir, 'node_modules', '@pyric', 'cli', 'dist', 'cli', 'index.js');
  return spawn('node', [cliBin, ...args], {
    cwd: app.dir,
    env: buildIsolatedEnv(app, label),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
}

export default scenario(async (app) => {
  // 1. #1775: SIGKILL to `pyric sandbox --hosted -- node server.mjs` stops the child and frees its port.
  const hostPort1 = await app.freePort();
  const appPort1 = await app.freePort();
  const pidFile1 = join(app.dir, 'child-1.pid');
  let childPid1: number | undefined;
  let host1 = app.pyricProcess([
    'sandbox',
    '--hosted',
    '--no-open',
    '--no-ui',
    '--host',
    '127.0.0.1',
    '--port',
    String(hostPort1),
    '--',
    'node',
    'server.mjs',
    String(appPort1),
    pidFile1,
  ]);
  try {
    childPid1 = await app.step('SIGKILL case: hosted sandbox starts and child listens on its port', () =>
      waitForChildListening(appPort1, pidFile1, 30_000));

    await app.step('SIGKILL case: killing pyric sandbox with SIGKILL ends its child and frees its port', async () => {
      const hostPid = host1.pid;
      assert.ok(hostPid !== undefined, 'pyric sandbox had no pid');
      assert.ok(childPid1 !== undefined, 'child server had no pid');
      // SIGKILL only the `pyric sandbox` host pid, matching `kill -9 <sandbox-pid>`.
      process.kill(hostPid, 'SIGKILL');
      const childWait = await waitUntilProcessGone(childPid1, 5_000);
      assert.equal(childWait.exited, true, `child pid ${childPid1} still ran 5s after host SIGKILL`);
      assert.equal(await waitForPortFree(appPort1, 2_000), true, `child port ${appPort1} stayed bound after host SIGKILL`);
      assert.equal(await waitForPortFree(hostPort1, 2_000), true, `host port ${hostPort1} stayed bound after host SIGKILL`);
    });
  } finally {
    forceCleanupPidAndGroup(childPid1);
    await host1.stop();
  }

  // Verify the next `pyric sandbox --hosted` in the same project can immediately rebind both ports (#1775)
  // AND stopping only the child by PID shuts `pyric sandbox` down cleanly without spinning (#1677).
  const pidFile2 = join(app.dir, 'child-2.pid');
  let host2: ChildProcess | undefined;
  let childPid2: number | undefined;
  try {
    await app.step('next sandbox in the project rebinds both ports, and killing the child exits the host (#1677)', async () => {
      host2 = spawnPackedPyric(
        app,
        [
          'sandbox',
          '--hosted',
          '--no-open',
          '--no-ui',
          '--host',
          '127.0.0.1',
          '--port',
          String(hostPort1),
          '--',
          'node',
          'server.mjs',
          String(appPort1),
          pidFile2,
        ],
        'rebind-and-child-exit',
      );
      host2.stdout?.on('data', () => {});
      host2.stderr?.on('data', () => {});
      childPid2 = await waitForChildListening(appPort1, pidFile2, 30_000);
      const roundTrip = await readChildFirestoreRoundTrip(appPort1);
      assert.equal(roundTrip?.status, 'ready', 'rebound child did not reach the hosted Firestore sandbox');
      const hostPid = host2.pid;
      assert.ok(hostPid !== undefined, 'second pyric sandbox had no pid');
      process.kill(childPid2, 'SIGTERM');
      const hostWait = await waitUntilProcessGone(hostPid, 5_000);
      assert.equal(hostWait.exited, true, 'pyric sandbox stayed alive after its child exited');
      assert.ok(
        hostWait.peakCpuTicks / CLOCK_TICKS_PER_SECOND < 1.0,
        `pyric sandbox spun on CPU after child exit (${hostWait.peakCpuTicks} ticks)`,
      );
    });
  } finally {
    forceCleanupPidAndGroup(childPid2);
    forceCleanupPidAndGroup(host2?.pid);
  }

  // 3. #1195: Closing stdout/stderr pipes does not cause an EPIPE spin; SIGINT stops the host and frees the lock.
  const hostPort3 = await app.freePort();
  let host3: ChildProcess | undefined;
  try {
    await app.step('closed stdout/stderr pipes: SIGINT stops the host without spinning and releases project lock (#1195)', async () => {
      host3 = spawnPackedPyric(
        app,
        ['sandbox', '--hosted', '--no-open', '--no-ui', '--host', '127.0.0.1', '--port', String(hostPort3)],
        'closed-pipes-sigint',
      );
      const hostPid = host3.pid;
      assert.ok(hostPid !== undefined, 'pyric sandbox had no pid');
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline && !ready) {
        try {
          const res = await fetch(`http://127.0.0.1:${hostPort3}/__pyric/health`, {
            signal: AbortSignal.timeout(500),
          });
          ready = res.status === 200;
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
        if (!ready) await sleep(100);
      }
      assert.equal(ready, true, 'hosted sandbox did not answer /__pyric/health');
      // Close both output pipe readers, matching `npx pyric sandbox --hosted 2>&1 | head -3`.
      host3.stdout?.destroy();
      host3.stderr?.destroy();
      await sleep(250);
      process.kill(hostPid, 'SIGINT');
      const hostWait = await waitUntilProcessGone(hostPid, 5_000);
      assert.equal(hostWait.exited, true, 'pyric sandbox ignored SIGINT after its output pipes closed');
      assert.ok(
        hostWait.peakCpuTicks / CLOCK_TICKS_PER_SECOND < 1.0,
        `pyric sandbox spun on CPU after pipe close (${hostWait.peakCpuTicks} ticks)`,
      );
      assert.equal(await waitForPortFree(hostPort3, 2_000), true, 'host port stayed bound after SIGINT');
    });
  } finally {
    forceCleanupPidAndGroup(host3?.pid);
  }

  // 4. #1551: Orphaned `pyric sandbox` (parent launcher killed) exits cleanly with its child without spinning.
  const hostPort4 = await app.freePort();
  const appPort4 = await app.freePort();
  const sandboxPidFile4 = join(app.dir, 'sandbox-4.pid');
  const childPidFile4 = join(app.dir, 'child-4.pid');
  let launcher4: ChildProcess | undefined;
  let sandboxPid4: number | undefined;
  let childPid4: number | undefined;
  try {
    await app.step('orphaned sandbox: losing its parent exits cleanly without CPU spin (#1551)', async () => {
      launcher4 = spawn(
        'node',
        ['launcher.mjs', String(hostPort4), String(appPort4), sandboxPidFile4, childPidFile4],
        {
          cwd: app.dir,
          env: buildIsolatedEnv(app, 'orphan-launcher'),
          stdio: 'ignore',
          detached: true,
        },
      );
      childPid4 = await waitForChildListening(appPort4, childPidFile4, 30_000);
      sandboxPid4 = Number(readFileSync(sandboxPidFile4, 'utf8').trim());
      assert.ok(Number.isInteger(sandboxPid4) && sandboxPid4 > 1, 'launcher wrote no sandbox pid');
      const launcherPid = launcher4.pid;
      assert.ok(launcherPid !== undefined, 'launcher had no pid');
      process.kill(launcherPid, 'SIGKILL');
      const sandboxWait = await waitUntilProcessGone(sandboxPid4, 5_000);
      assert.equal(sandboxWait.exited, true, 'orphaned pyric sandbox stayed running after parent died');
      assert.ok(
        sandboxWait.peakCpuTicks / CLOCK_TICKS_PER_SECOND < 1.0,
        `orphaned pyric sandbox spun on CPU (${sandboxWait.peakCpuTicks} ticks)`,
      );
      const childWait = await waitUntilProcessGone(childPid4, 5_000);
      assert.equal(childWait.exited, true, 'orphaned sandbox left its child server running');
    });
  } finally {
    forceCleanupPidAndGroup(launcher4?.pid);
    forceCleanupPidAndGroup(sandboxPid4);
    forceCleanupPidAndGroup(childPid4);
  }
});
