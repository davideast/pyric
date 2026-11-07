/**
 * A live Node process ends its connection to the live host when it exits,
 * so the host detaches the listeners it reported at once instead of after
 * the session retention, and a restart under `node --watch` or nodemon
 * raises no false duplicate-listener incident. It names itself with a label
 * for its project root and entry script, so the host can tell a restart of
 * the same process from another process. Neither changes how the process
 * exits.
 */
import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { endWithProcess, nodeClientLabel, nodeClientScript, type ExitingProcess } from '../../src/register/node-client.js';

/** A process stand-in: its events, and the signals it sends itself. */
function fakeProcess(): ExitingProcess & { emitter: EventEmitter; killed: string[] } {
  const emitter = new EventEmitter();
  const killed: string[] = [];
  return {
    emitter,
    killed,
    pid: 4242,
    on: (event, listener) => emitter.on(event, listener),
    once: (event, listener) => emitter.once(event, listener),
    listenerCount: (event) => emitter.listenerCount(event),
    kill: (pid, signal) => {
      killed.push(`${pid}:${signal}`);
      return true;
    },
  };
}

/** An end that records each call and resolves when told to. */
function recordedEnd(): { end: () => Promise<void>; calls: number; finish: () => void } {
  let finish = (): void => {};
  const state = {
    calls: 0,
    end: (): Promise<void> => {
      state.calls += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    finish: (): void => finish(),
  };
  return state;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('a live Node process ends its host connection as it exits', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    it(`ends it on ${signal}, then exits by the signal as it would have`, async () => {
      const proc = fakeProcess();
      const ending = recordedEnd();
      endWithProcess(ending.end, proc);
      proc.emitter.emit(signal, signal);
      expect(ending.calls).toBe(1);
      expect(proc.killed).toEqual([]);
      ending.finish();
      await settle();
      expect(proc.killed).toEqual([`4242:${signal}`]);
    });

    it(`ends it on ${signal} and leaves the exit to the app's own handler`, async () => {
      const proc = fakeProcess();
      const ending = recordedEnd();
      proc.emitter.on(signal, () => {});
      endWithProcess(ending.end, proc);
      proc.emitter.emit(signal, signal);
      ending.finish();
      await settle();
      expect(ending.calls).toBe(1);
      expect(proc.killed).toEqual([]);
    });
  }

  it('exits by the signal even when ending the connection fails', async () => {
    const proc = fakeProcess();
    endWithProcess(() => Promise.reject(new Error('host gone')), proc);
    proc.emitter.emit('SIGTERM', 'SIGTERM');
    await settle();
    expect(proc.killed).toEqual(['4242:SIGTERM']);
  });

  it('ends it each time the event loop empties, and sends itself no signal', async () => {
    const proc = fakeProcess();
    const ending = recordedEnd();
    endWithProcess(ending.end, proc);
    proc.emitter.emit('beforeExit', 0);
    ending.finish();
    proc.emitter.emit('beforeExit', 0);
    await settle();
    expect(ending.calls).toBe(2);
    expect(proc.killed).toEqual([]);
  });
});

describe('the label a live Node process names itself by', () => {
  const root = '/srv/rooms';

  it('is the same for a restart of one entry script in one project', () => {
    const first = nodeClientLabel({ projectRoot: root, cwd: root, entry: 'server.mjs', execArgv: [] });
    const restart = nodeClientLabel({ projectRoot: root, cwd: root, entry: `${root}/server.mjs`, execArgv: ['--watch'] });
    expect(restart).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs for another entry script or another project', () => {
    const server = nodeClientLabel({ projectRoot: root, cwd: root, entry: 'server.mjs', execArgv: [] });
    const worker = nodeClientLabel({ projectRoot: root, cwd: root, entry: 'worker.mjs', execArgv: [] });
    const elsewhere = nodeClientLabel({ projectRoot: '/srv/other', cwd: '/srv/other', entry: 'server.mjs', execArgv: [] });
    expect(new Set([server, worker, elsewhere]).size).toBe(3);
  });

  it('carries no path', () => {
    const label = nodeClientLabel({ projectRoot: root, cwd: root, entry: 'server.mjs', execArgv: [] });
    expect(label).not.toContain('srv');
    expect(label).not.toContain('server');
  });
});

describe('the script a live Node process names on the host', () => {
  const cwd = '/srv/rooms';

  it('is the entry script relative to the working directory', () => {
    expect(nodeClientScript({ cwd, entry: `${cwd}/server.mjs`, execArgv: [] })).toBe('server.mjs');
    expect(nodeClientScript({ cwd, entry: 'jobs/nightly.ts', execArgv: ['--watch'] })).toBe('jobs/nightly.ts');
    expect(nodeClientScript({ cwd: `${cwd}/jobs`, entry: `${cwd}/server.mjs`, execArgv: [] })).toBe('../server.mjs');
  });

  it('is never an absolute path', () => {
    const script = nodeClientScript({ cwd: '/home/ada/rooms', entry: '/home/ada/rooms/server.mjs', execArgv: [] });
    expect(script).toBe('server.mjs');
    expect(script).not.toContain('/home');
  });

  it('is absent with no entry script, or one too long to keep', () => {
    expect(nodeClientScript({ cwd, entry: undefined, execArgv: [] })).toBeUndefined();
    expect(nodeClientScript({ cwd, entry: 'server.mjs', execArgv: ['-e'] })).toBeUndefined();
    expect(nodeClientScript({ cwd, entry: cwd, execArgv: [] })).toBeUndefined();
    expect(nodeClientScript({ cwd, entry: `${'a'.repeat(257)}.mjs`, execArgv: [] })).toBeUndefined();
  });
});
