import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppProcess, AppRun, freePort, portIssuer, probePort, type PortIssuer, type SpawnChild } from './driver.ts';

/** A child that never gets a pid, so the driver sends it no signal. */
function standIn(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { stdout: new EventEmitter(), stderr: new EventEmitter(), pid: undefined });
  return child;
}

function spawnError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: spawn failed, epoll_ctl`), { code });
}

/** A spawner whose children each do what the next script entry says, one tick after they start. */
function scriptedSpawner(script: Array<(child: ChildProcess) => void>): { spawnChild: SpawnChild; spawned: () => number } {
  let count = 0;
  const spawnChild: SpawnChild = () => {
    const child = standIn();
    const act = script[count] ?? script[script.length - 1]!;
    count += 1;
    queueMicrotask(() => act(child));
    return child;
  };
  return { spawnChild, spawned: () => count };
}

const failsWith = (code: string) => (child: ChildProcess) => { child.emit('error', spawnError(code)); };
const closesWith = (code: number) => (child: ChildProcess) => { child.emit('close', code, null); };

function appProcess(spawnChild: SpawnChild): AppProcess {
  return new AppProcess('stand-in', 'node', ['server.mjs'], '.', {}, spawnChild);
}

describe('spawn retry', () => {
  test('an EBADF before any output starts the child once more', async () => {
    const { spawnChild, spawned } = scriptedSpawner([failsWith('EBADF'), closesWith(0)]);
    const child = appProcess(spawnChild);
    expect(await child.exited).toBe(0);
    expect(spawned()).toBe(2);
    expect(child.output).toContain('could not start node: EBADF: spawn failed, epoll_ctl; the child wrote no output, so the driver starts it once more');
  });

  test('a second EBADF fails the process', async () => {
    const { spawnChild, spawned } = scriptedSpawner([failsWith('EBADF'), failsWith('EBADF')]);
    const child = appProcess(spawnChild);
    expect(await child.exited).toBeNull();
    expect(spawned()).toBe(2);
    expect(child.running).toBe(false);
    expect(child.output.trimEnd().endsWith('[driver] could not start node: EBADF: spawn failed, epoll_ctl')).toBe(true);
  });

  test('another spawn error does not retry', async () => {
    const { spawnChild, spawned } = scriptedSpawner([failsWith('ENOENT'), closesWith(0)]);
    const child = appProcess(spawnChild);
    expect(await child.exited).toBeNull();
    expect(spawned()).toBe(1);
  });

  test('an EBADF after the child wrote output does not retry', async () => {
    const wroteThenFailed = (child: ChildProcess) => {
      child.stdout!.emit('data', 'listening\n');
      child.emit('error', spawnError('EBADF'));
    };
    const { spawnChild, spawned } = scriptedSpawner([wroteThenFailed, closesWith(0)]);
    const child = appProcess(spawnChild);
    expect(await child.exited).toBeNull();
    expect(spawned()).toBe(1);
    expect(child.output).toStartWith('listening\n');
  });

  test('events from the abandoned child are ignored', async () => {
    let first: ChildProcess | undefined;
    const failThenClose = (child: ChildProcess) => {
      first = child;
      child.emit('error', spawnError('EBADF'));
    };
    const { spawnChild } = scriptedSpawner([failThenClose, () => {}]);
    const child = appProcess(spawnChild);
    await Promise.resolve();
    await Promise.resolve();
    first!.emit('close', 1, null);
    first!.stdout!.emit('data', 'late\n');
    expect(child.running).toBe(true);
    expect(child.output).not.toContain('late');
  });
});

describe('stop', () => {
  test('a child that never closes after SIGKILL is recorded as gone', async () => {
    // The group's shell and sleep die, but a sleep in its own session keeps
    // the stdout pipe open, so the child exits and never emits `close`.
    const child = new AppProcess(
      'pipe holder',
      'sh',
      ['-c', `setsid sh -c 'echo $$; exec sleep 30' & exec sleep 30`],
      '.',
      { PATH: process.env.PATH },
    );
    const match = await child.waitForLog(/^(\d+)$/m, { timeoutMs: 5_000 });
    const holder = Number(match[1]);
    try {
      await child.stop({ termMs: 200, killMs: 200 });
      expect(child.running).toBe(false);
      expect(await child.exited).toBeNull();
      expect(child.output).toContain('[driver] pipe holder did not close within 0.2s of SIGKILL; the driver records it as gone');
    } finally {
      try { process.kill(holder, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  test('a child that closes on SIGTERM stops without the SIGKILL note', async () => {
    const child = new AppProcess('sleeper', 'sleep', ['30'], '.', { PATH: process.env.PATH });
    await child.stop({ termMs: 2_000, killMs: 200 });
    expect(child.running).toBe(false);
    expect(child.output).toContain('[driver] exited on SIGTERM');
    expect(child.output).not.toContain('records it as gone');
  });
});

/** A probe that returns each scripted port in turn, then repeats the last one. */
function scriptedProbe(script: number[]): { probe: () => Promise<number>; probes: () => number } {
  let count = 0;
  const probe = async (): Promise<number> => {
    const port = script[count] ?? script[script.length - 1]!;
    count += 1;
    return port;
  };
  return { probe, probes: () => count };
}

describe('port issuer', () => {
  test('a probe that repeats a port is asked again, so the second port differs', async () => {
    const { probe, probes } = scriptedProbe([33093, 33093, 33094]);
    const ports = portIssuer(probe);
    const first = await ports.next();
    const second = await ports.next();
    expect([first, second]).toEqual([33093, 33094]);
    expect(probes()).toBe(3);
  });

  test('a probe that only repeats fails with the ports it returned', async () => {
    const { probe, probes } = scriptedProbe([33093]);
    const ports = portIssuer(probe);
    await ports.next();
    await expect(ports.next()).rejects.toThrow(/^no unissued port after 32 probes; the probe only returned 33093$/);
    expect(probes()).toBe(33);
  });

});

/** An app run that is never installed or browsed, with its ports from `ports`. */
function bareRun(ports: PortIssuer): AppRun {
  const noBrowser = () => Promise.reject(new Error('no browser in this test'));
  return new AppRun('stand-in', '.', '.', noBrowser, undefined, ports);
}

describe('app ports', () => {
  test('freePort() asks the issuer, so a repeated probe gives a different port', async () => {
    const { probe } = scriptedProbe([33093, 33093, 33094]);
    const ports = portIssuer(probe);
    expect([await freePort(ports), await freePort(ports)]).toEqual([33093, 33094]);
  });

  test('app.freePort() asks the run issuer, so a repeated probe gives a different port', async () => {
    const { probe } = scriptedProbe([33093, 33093, 33094]);
    const app = bareRun(portIssuer(probe));
    expect([await app.freePort(), await app.freePort()]).toEqual([33093, 33094]);
  });

  test('a blackholed port is issued, so a later app.freePort() never returns it', async () => {
    const real = await probePort();
    const { probe } = scriptedProbe([real, real, 33094]);
    const app = bareRun(portIssuer(probe));
    try {
      expect(await app.blackholedPort()).toBe(real);
      expect(await app.freePort()).toBe(33094);
    } finally {
      await app.close();
    }
  });
});

/**
 * A stand-in npm: every call writes a debug log to its --logs-dir and leaves
 * a file in node_modules. The calls listed in `hangs` (1-based) then wait on
 * a child, as npm waits on an install script, until stopped; the others exit 0. A call that finds an earlier call's
 * node_modules says so in `leftovers`.
 */
function fakeNpm(dir: string, hangs: number[]): string {
  const script = join(dir, 'fake-npm.sh');
  writeFileSync(script, `#!/bin/bash
calls="${dir}/calls"
n=$(( $(cat "$calls" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$calls"
logs=""
for arg in "$@"; do case "$arg" in --logs-dir=*) logs="\${arg#--logs-dir=}";; esac; done
mkdir -p "$logs"
printf '0 verbose cli fake npm call %s\\n1 http fetch GET https://registry.npmjs.org/stalled-%s\\n' "$n" "$n" > "$logs/2026-10-28T12_0\${n}_00_000Z-debug-0.log"
[ -e node_modules/left-by-call ] && echo "call $n found node_modules from an earlier call" >> "${dir}/leftovers"
mkdir -p node_modules && touch node_modules/left-by-call
case " ${hangs.join(' ')} " in *" $n "*) sleep 31 & wait;; esac
echo "added 1 package"
`);
  chmodSync(script, 0o755);
  return script;
}

function installRun(hangs: number[]) {
  const work = mkdtempSync(join(tmpdir(), 'pyric-install-project-'));
  mkdirSync(join(work, 'app', 'my-chat'), { recursive: true });
  writeFileSync(join(work, 'app', 'my-chat', 'package.json'), '{"name":"my-chat","private":true}\n');
  const lines: string[] = [];
  const npm = { command: fakeNpm(work, hangs), attemptMs: 1_000, report: (line: string) => lines.push(line) };
  const noBrowser = () => Promise.reject(new Error('no browser in this test'));
  const run = new AppRun('chat', join(work, 'app'), join(work, 'home'), noBrowser, { tarballs: new Map(), npmCache: join(work, 'cache'), npm });
  const read = (name: string) => (existsSync(join(work, name)) ? readFileSync(join(work, name), 'utf8') : '');
  return { run, lines, read, done: () => rmSync(work, { recursive: true, force: true }) };
}

describe('installProject when npm hangs (#1476)', () => {
  test('a hung attempt prints its npm debug log to the run output at once, and a fresh attempt passes', async () => {
    const { run, lines, read, done } = installRun([1]);
    try {
      const result = await run.installProject('my-chat');
      expect(result.code).toBe(0);
      expect(read('calls').trim()).toBe('2');
      expect(read('leftovers')).toBe('');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toStartWith('[runner] chat: npm install in my-chat stopped after 1 s');
      expect(lines[0]).toContain('[runner] processes in its group when it was stopped:');
      expect(lines[0]).toMatch(/pid \d+ parent \d+ state \w: \S*bash \S*fake-npm\.sh install/);
      expect(lines[0]).toMatch(/pid \d+ parent \d+ state \w: sleep 31/);
      expect(lines[0]).toContain("[runner] the end of npm's debug log 2026-10-28T12_01_00_000Z-debug-0.log");
      expect(lines[0]).toContain('http fetch GET https://registry.npmjs.org/stalled-1');
      expect(lines[1]).toStartWith('[runner] infrastructure retry: chat: npm install in my-chat timed out');
      expect(lines[2]).toMatch(/exited 0 in \d+ s, 2 attempts \(1 infrastructure retry\)$/);
    } finally {
      await run.close();
      done();
    }
  }, 20_000);

  test('a second hang fails the install with both debug logs, and is not tried a third time', async () => {
    const { run, lines, read, done } = installRun([1, 2]);
    try {
      const failure = await run.installProject('my-chat').then(() => undefined, (error: Error) => error);
      expect(failure?.message).toContain('npm install in my-chat timed out on both attempts');
      expect(failure?.message).toContain('stalled-1');
      expect(failure?.message).toContain('stalled-2');
      expect(read('calls').trim()).toBe('2');
      expect(lines.filter((line) => line.includes('stopped after'))).toHaveLength(2);
      expect(lines.at(-1)).toMatch(/timed out in \d+ s, 2 attempts \(1 infrastructure retry\)$/);
    } finally {
      await run.close();
      done();
    }
  }, 20_000);
});
