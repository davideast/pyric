import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AppProcess, portIssuer, type SpawnChild } from './driver.ts';

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

  test('a reserved port is never handed out', async () => {
    const { probe } = scriptedProbe([40000, 40001]);
    const ports = portIssuer(probe);
    ports.reserve(40000);
    expect(await ports.next()).toBe(40001);
  });

  test('a probe that only repeats fails with the ports it returned', async () => {
    const { probe, probes } = scriptedProbe([33093]);
    const ports = portIssuer(probe);
    await ports.next();
    await expect(ports.next()).rejects.toThrow(/^no unissued port after 32 probes; the probe only returned 33093$/);
    expect(probes()).toBe(33);
  });

  test('the default probe hands out distinct real ports', async () => {
    const ports = portIssuer();
    const issued: number[] = [];
    for (let count = 0; count < 8; count += 1) issued.push(await ports.next());
    expect(new Set(issued).size).toBe(issued.length);
  });
});
