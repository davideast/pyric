/**
 * A handler stuck in a synchronous loop stops the child's event loop, so
 * every HTTP function and RTDB trigger stalls with it. The child beats over
 * IPC; the host notices missed beats, and the runtime restarts the child.
 */
import { describe, expect, it } from 'bun:test';
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

/** Stands in for the real child entry: ready, then a beat every 100 ms until told to wedge. */
const FAKE_CHILD = `
process.send({ type: 'ready', triggerCount: 0, unsupportedTriggers: [] });
setInterval(() => process.send({ type: 'heartbeat' }), 100);
process.on('message', (message) => {
  if (message.type === 'wedge') { const until = Date.now() + 60000; while (Date.now() < until) {} }
  if (message.type === 'stop') process.exit(0);
});
`;

function fakeChildModule(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-heartbeat-'));
  const file = join(dir, 'child.cjs');
  writeFileSync(file, FAKE_CHILD);
  return pathToFileURL(file);
}

function spawnFake(onUnresponsive: () => void): FunctionsChildHandle {
  return spawnFunctionsChild({
    cwd: tmpdir(),
    entry: join(tmpdir(), 'index.js'),
    env: process.env,
    instance: 'demo-default-rtdb',
    location: 'us-central1',
    projectId: 'demo',
    childModuleUrl: fakeChildModule(),
    heartbeatTimeoutMs: 500,
    onUnresponsive,
  });
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
