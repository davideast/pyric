/**
 * A handler stuck in a synchronous loop stops the child's event loop, so
 * every HTTP function and RTDB trigger stalls with it. The child beats over
 * IPC; the host notices missed beats, and the runtime restarts the child.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  createFunctionsDevelopmentRuntime,
  type FunctionsDevelopmentEvent,
} from '../../src/functions/development-runtime.js';
import { spawnFunctionsChild, type FunctionsChildHandle, type SpawnFunctionsChildOptions } from '../../src/functions/spawn.js';
import { heartbeatLimitMs, watchHeartbeat } from '../../src/functions/heartbeat.js';

/**
 * Stands in for the real child entry: ready, then a beat every 100 ms until
 * told to wedge, for `ms` or a minute. `READY_HTTP` is the http part of its
 * ready message, so a test can serve a function with a `timeoutSeconds`.
 */
const FAKE_CHILD = `
process.send({ type: 'ready', triggerCount: 0, unsupportedTriggers: [], ...READY_HTTP });
setInterval(() => process.send({ type: 'heartbeat' }), 100);
process.on('message', (message) => {
  if (message.type === 'wedge') { const until = Date.now() + (message.ms ?? 60000); while (Date.now() < until) {} }
  if (message.type === 'stop') process.exit(0);
});
`;

function fakeChildModule(http?: object): URL {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-heartbeat-'));
  const file = join(dir, 'child.cjs');
  const readyHttp = http === undefined ? '{}' : JSON.stringify({ http });
  writeFileSync(file, FAKE_CHILD.replace('READY_HTTP', readyHttp));
  return pathToFileURL(file);
}

/** A child serving one HTTP function that production lets run for 2 s. */
const TWO_SECOND_FUNCTION = {
  port: 1,
  functions: [{ exportName: 'transform', regions: ['us-central1'], platform: 'gcfv2', privateInvoker: false, timeoutSeconds: 2 }],
};

const spawnedFakes: FunctionsChildHandle[] = [];

afterEach(() => {
  for (const handle of spawnedFakes.splice(0)) {
    if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGKILL');
  }
});

function spawnFake(onUnresponsive: () => void, http?: object): FunctionsChildHandle {
  const handle = spawnFunctionsChild({
    cwd: tmpdir(),
    entry: join(tmpdir(), 'index.js'),
    env: process.env,
    instance: 'demo-default-rtdb',
    location: 'us-central1',
    projectId: 'demo',
    childModuleUrl: fakeChildModule(http),
    heartbeatTimeoutMs: 500,
    onUnresponsive,
  });
  spawnedFakes.push(handle);
  return handle;
}

describe('Functions child heartbeat', () => {
  it('a beating child is never reported', async () => {
    let reported = 0;
    const handle = spawnFake(() => { reported += 1; });
    await handle.ready;
    await Bun.sleep(1_200);
    expect(reported).toBe(0);
    await handle.stop();
  });

  it('a wedged child is reported once, and stop still ends it', async () => {
    let reported = 0;
    const handle = spawnFake(() => { reported += 1; });
    await handle.ready;
    handle.child.send({ type: 'wedge' });
    const deadline = Date.now() + 3_000;
    while (reported === 0 && Date.now() < deadline) await Bun.sleep(50);
    expect(reported).toBe(1);
    await Bun.sleep(700);
    expect(reported).toBe(1);
    const code = await handle.stop();
    expect(typeof code).toBe('number');
  }, 10_000);

  it('synchronous work within the function\'s own timeoutSeconds is not reported; past it, it is', async () => {
    let reported = 0;
    const handle = spawnFake(() => { reported += 1; }, TWO_SECOND_FUNCTION);
    const ready = await handle.ready;
    expect(ready.http?.token).toMatch(/^[\w-]{43}$/);
    // 1.5 s of silence is three times the 500 ms floor, and still inside the function's 2 s.
    handle.child.send({ type: 'wedge', ms: 1_500 });
    await Bun.sleep(2_500);
    expect(reported).toBe(0);
    handle.child.send({ type: 'wedge' });
    const deadline = Date.now() + 6_000;
    while (reported === 0 && Date.now() < deadline) await Bun.sleep(50);
    expect(reported).toBe(1);
    await handle.stop();
  }, 15_000);

  it('the limit is the longest timeoutSeconds plus one beat, the platform default when unset, capped at an hour', () => {
    const fn = (timeoutSeconds: number | null) => ({ exportName: 'f', regions: ['us-central1'], platform: 'gcfv2' as const, privateInvoker: false, timeoutSeconds });
    expect(heartbeatLimitMs(undefined, 10_000)).toBe(10_000);
    expect(heartbeatLimitMs({ port: 1, functions: [fn(2)] }, 10_000)).toBe(10_000);
    expect(heartbeatLimitMs({ port: 1, functions: [fn(30), fn(null)] }, 10_000)).toBe(61_000);
    expect(heartbeatLimitMs({ port: 1, functions: [fn(9_000)] }, 10_000)).toBe(3_601_000);
  });

  it('a wall-clock jump, as when a laptop wakes from sleep, does not count as silence', async () => {
    let reported = 0;
    const realNow = Date.now;
    const watch = watchHeartbeat({ limitMs: 1_000, onSilent: () => { reported += 1; }, isStopping: () => false });
    try {
      watch.beat();
      Date.now = () => realNow() + 3_600_000;
      // One check runs every 500 ms; no beat arrives in between.
      await Bun.sleep(700);
      expect(reported).toBe(0);
    } finally {
      Date.now = realNow;
      watch.stop();
    }
  });

  it('the runtime restarts an unresponsive child and reports both steps', async () => {
    const spawned: SpawnFunctionsChildOptions[] = [];
    const events: FunctionsDevelopmentEvent[] = [];
    const runtime = createFunctionsDevelopmentRuntime({
      sourceDir: '/project/functions',
      entry: '/project/functions/index.js',
      baseEnv: {},
      serveUrl: 'http://localhost:4321',
      registerUrl: 'file:///register.js',
      instance: 'demo-default-rtdb',
      projectId: 'demo',
      location: 'us-central1',
      readiness: { wait: async () => true },
      onEvent: (event) => events.push(event),
      spawn: (options) => {
        spawned.push(options);
        const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
        let exit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => { exit = resolve; });
        return {
          child: child as unknown as ChildProcess,
          ready: Promise.resolve({ triggerCount: 0, unsupportedTriggers: [] }),
          exited,
          async stop() { exit(0); return 0; },
        };
      },
    });
    expect((await runtime.start()).kind).toBe('ready');
    spawned[0].onUnresponsive?.();
    const deadline = Date.now() + 2_000;
    while (!events.some((event) => event.type === 'restarted') && Date.now() < deadline) await Bun.sleep(10);
    const kinds = events.filter((event) => event.type === 'unresponsive' || event.type === 'restarted');
    expect(kinds).toEqual([
      { type: 'unresponsive' },
      { type: 'restarted', result: { kind: 'ready', ready: { triggerCount: 0, unsupportedTriggers: [] } } },
    ]);
    expect(spawned).toHaveLength(2);
    await runtime.close();
  });
});
