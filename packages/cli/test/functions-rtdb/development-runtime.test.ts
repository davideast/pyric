import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type {
  FunctionsRtdbChildHandle,
  FunctionsRtdbChildReady,
} from '../../src/functions-rtdb/child.js';
import {
  createFunctionsDevelopmentRuntime,
  type FunctionsDevelopmentEvent,
  type FunctionsPeerReadiness,
} from '../../src/functions-rtdb/development-runtime.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakeChild(ready: Promise<FunctionsRtdbChildReady>) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exit = deferred<number>();
  let stops = 0;
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcess;
  const handle: FunctionsRtdbChildHandle = {
    child,
    ready,
    exited: exit.promise,
    async stop() { stops += 1; exit.resolve(0); return 0; },
  };
  return { handle, stdout, stderr, exit, stops: () => stops };
}

function runtimeOptions(
  readiness: FunctionsPeerReadiness,
  spawn: () => FunctionsRtdbChildHandle,
  events: FunctionsDevelopmentEvent[] = [],
) {
  return {
    sourceDir: '/project/functions',
    entry: '/project/functions/index.js',
    baseEnv: {},
    serveUrl: 'http://localhost:4321',
    registerUrl: 'file:///register.js',
    instance: 'demo-project-default-rtdb',
    location: 'us-central1',
    readiness,
    onEvent: (event: FunctionsDevelopmentEvent) => events.push(event),
    spawn,
  };
}

describe('Functions development runtime', () => {
  it('reports no-peer without spawning and aborts an active wait on close', async () => {
    let aborted = false;
    const readiness: FunctionsPeerReadiness = {
      wait: ({ signal }) => new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve(false); }, { once: true });
      }),
    };
    const runtime = createFunctionsDevelopmentRuntime(runtimeOptions(readiness, () => { throw new Error('spawned'); }));
    const start = runtime.start();
    await runtime.close();
    expect(await start).toEqual({ kind: 'no-peer' });
    expect(aborted).toBe(true);
  });

  it('stops the child before awaiting a pending ready transition', async () => {
    const ready = deferred<FunctionsRtdbChildReady>();
    const child = fakeChild(ready.promise);
    child.handle.stop = async () => {
      ready.reject(new Error('stopped during module evaluation'));
      child.exit.resolve(0);
      return 0;
    };
    const runtime = createFunctionsDevelopmentRuntime(runtimeOptions(
      { wait: async () => true },
      () => child.handle,
    ));
    const start = runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await runtime.close();
    expect((await start).kind).toBe('failed');
  });

  it('returns readiness and emits framed output plus child events', async () => {
    const events: FunctionsDevelopmentEvent[] = [];
    const child = fakeChild(Promise.resolve({ triggerCount: 1, unsupportedTriggers: [] }));
    let childEvent: ((event: never) => void) | undefined;
    const runtime = createFunctionsDevelopmentRuntime({
      ...runtimeOptions({ wait: async () => true }, () => child.handle, events),
      spawn: (options) => { childEvent = options.onEvent as (event: never) => void; return child.handle; },
    });
    expect(await runtime.start()).toEqual({
      kind: 'ready',
      ready: { triggerCount: 1, unsupportedTriggers: [] },
    });
    child.stdout.write('one\ntwo');
    child.stdout.end();
    childEvent?.({ type: 'delivery-error', exportName: 'write', error: { name: 'Error', message: 'nope' } } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual({ type: 'output', stream: 'stdout', line: '[functions] one\n' });
    expect(events).toContainEqual({ type: 'output', stream: 'stdout', line: '[functions] two\n' });
    expect(events.some((event) => event.type === 'child-event')).toBe(true);
    await runtime.close();
  });

  it('takes functions down on a failed reload', async () => {
    const first = fakeChild(Promise.resolve({ triggerCount: 1, unsupportedTriggers: [] }));
    const second = fakeChild(Promise.reject(new Error('broken save')));
    const children = [first, second];
    const runtime = createFunctionsDevelopmentRuntime(runtimeOptions(
      { wait: async () => true },
      () => children.shift()!.handle,
    ));
    expect((await runtime.start()).kind).toBe('ready');
    const result = await runtime.reload();
    expect(result.kind).toBe('failed');
    expect(first.stops()).toBe(1);
    expect(second.stops()).toBe(1);
    await runtime.close();
  });

  it('serializes reloads and coalesces concurrent requests into one follow-up', async () => {
    const initial = fakeChild(Promise.resolve({ triggerCount: 1, unsupportedTriggers: [] }));
    const ready2 = deferred<FunctionsRtdbChildReady>();
    const second = fakeChild(ready2.promise);
    const third = fakeChild(Promise.resolve({ triggerCount: 3, unsupportedTriggers: [] }));
    const children = [initial, second, third];
    const runtime = createFunctionsDevelopmentRuntime(runtimeOptions(
      { wait: async () => true },
      () => children.shift()!.handle,
    ));
    await runtime.start();
    const firstReload = runtime.reload();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queuedA = runtime.reload();
    const queuedB = runtime.reload();
    ready2.resolve({ triggerCount: 2, unsupportedTriggers: [] });
    expect(await firstReload).toEqual({ kind: 'ready', ready: { triggerCount: 3, unsupportedTriggers: [] } });
    expect(await queuedA).toEqual(await queuedB);
    expect(children).toHaveLength(0);
    await runtime.close();
  });

  it('queues a reload behind an in-progress initial start', async () => {
    const initialReady = deferred<FunctionsRtdbChildReady>();
    const initial = fakeChild(initialReady.promise);
    const reloaded = fakeChild(Promise.resolve({ triggerCount: 2, unsupportedTriggers: [] }));
    const children = [initial, reloaded];
    let spawns = 0;
    const runtime = createFunctionsDevelopmentRuntime(runtimeOptions(
      { wait: async () => true },
      () => { spawns += 1; return children.shift()!.handle; },
    ));
    const start = runtime.start();
    const reload = runtime.reload();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spawns).toBe(1);
    initialReady.resolve({ triggerCount: 1, unsupportedTriggers: [] });
    expect((await start).kind).toBe('ready');
    expect(await reload).toEqual({
      kind: 'ready',
      ready: { triggerCount: 2, unsupportedTriggers: [] },
    });
    expect(initial.stops()).toBe(1);
    await runtime.close();
  });

  it('emits an unexpected-exit event only for the active ready child', async () => {
    const events: FunctionsDevelopmentEvent[] = [];
    const child = fakeChild(Promise.resolve({ triggerCount: 1, unsupportedTriggers: [] }));
    const runtime = createFunctionsDevelopmentRuntime(runtimeOptions(
      { wait: async () => true },
      () => child.handle,
      events,
    ));
    await runtime.start();
    child.exit.resolve(7);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual({ type: 'unexpected-exit', code: 7 });
  });

  it('does not lose an exit already settled when readiness resolves', async () => {
    const events: FunctionsDevelopmentEvent[] = [];
    const child = fakeChild(Promise.resolve({ triggerCount: 1, unsupportedTriggers: [] }));
    child.exit.resolve(9);
    const runtime = createFunctionsDevelopmentRuntime(runtimeOptions(
      { wait: async () => true },
      () => child.handle,
      events,
    ));
    expect((await runtime.start()).kind).toBe('ready');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toContainEqual({ type: 'unexpected-exit', code: 9 });
  });
});
