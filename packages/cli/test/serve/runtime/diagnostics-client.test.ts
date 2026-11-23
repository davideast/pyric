import { JSDOM } from 'jsdom';
import { afterEach, expect, test } from 'bun:test';
import {
  deferDiagnosticReporting,
  recordDiagnostic,
  resumeDiagnosticReporting,
  stopDiagnosticReporting,
} from '../../../src/serve/runtime/diagnostics-client.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  stopDiagnosticReporting(false);
  delete globalThis.__pyricDiagnostics;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function installPageGlobals(url: string, onFetch: typeof fetch): void {
  const dom = new JSDOM('<!doctype html><body></body>', { url });
  const prevLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const prevFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'location', {
    value: dom.window.location,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: onFetch,
    configurable: true,
    writable: true,
  });
  cleanups.push(() => {
    if (prevLocationDescriptor !== undefined) {
      Object.defineProperty(globalThis, 'location', prevLocationDescriptor);
    } else {
      delete (globalThis as { location?: unknown }).location;
    }
    if (prevFetchDescriptor !== undefined) {
      Object.defineProperty(globalThis, 'fetch', prevFetchDescriptor);
    } else {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
    dom.window.close();
  });
}

test('stopDiagnosticReporting cancels scheduled HTTP flushes while keeping local events (#2056)', async () => {
  let postCount = 0;
  installPageGlobals('http://10.203.0.1:5000/', (async () => {
    postCount += 1;
    return new Response('forbidden', { status: 403 });
  }) as typeof fetch);

  recordDiagnostic({ phase: 'init-request' });
  stopDiagnosticReporting();
  recordDiagnostic({ phase: 'init-failed' });
  await new Promise(resolve => setTimeout(resolve, 160));

  expect(postCount).toBe(0);
  expect(globalThis.__pyricDiagnostics?.getSnapshot().events).toHaveLength(2);
});

test('deferDiagnosticReporting holds HTTP flushes across slow init until resumed or stopped (#3264)', async () => {
  const bodies: Array<{ events: Array<{ phase: string }> }> = [];
  installPageGlobals('http://127.0.0.1:5000/', (async (_url, init) => {
    if (typeof init?.body === 'string') {
      bodies.push(JSON.parse(init.body) as { events: Array<{ phase: string }> });
    }
    return new Response(null, { status: 204 });
  }) as typeof fetch);

  deferDiagnosticReporting();
  recordDiagnostic({ phase: 'init-request' });
  globalThis.dispatchEvent(new Event('online'));
  globalThis.dispatchEvent(new Event('pagehide'));
  await new Promise(resolve => setTimeout(resolve, 160));

  expect(bodies).toHaveLength(0);
  expect(globalThis.__pyricDiagnostics?.getSnapshot().events.map(e => e.phase)).toEqual([
    'init-request',
  ]);

  resumeDiagnosticReporting();
  recordDiagnostic({ phase: 'init-ready', code: 200 });
  await new Promise(resolve => setTimeout(resolve, 160));

  expect(bodies).toHaveLength(1);
  expect(bodies[0]?.events.map(e => e.phase)).toEqual(['init-request', 'init-ready']);
});

test('stopDiagnosticReporting wins over defer and resume and blocks pagehide flushes (#3264)', async () => {
  let postCount = 0;
  installPageGlobals('http://10.203.0.1:5000/', (async () => {
    postCount += 1;
    return new Response('forbidden', { status: 403 });
  }) as typeof fetch);

  deferDiagnosticReporting();
  recordDiagnostic({ phase: 'init-request' });
  await new Promise(resolve => setTimeout(resolve, 160));
  expect(postCount).toBe(0);

  stopDiagnosticReporting();
  resumeDiagnosticReporting();
  deferDiagnosticReporting();
  recordDiagnostic({ phase: 'init-failed', code: 200 });
  globalThis.dispatchEvent(new Event('online'));
  globalThis.dispatchEvent(new Event('pagehide'));
  await new Promise(resolve => setTimeout(resolve, 160));

  expect(postCount).toBe(0);
  expect(globalThis.__pyricDiagnostics?.getSnapshot().events.map(e => e.phase)).toEqual([
    'init-request',
    'init-failed',
  ]);
});

test('cleanup restores globalThis.location without leaving it readonly', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const isAssignable =
    descriptor === undefined || descriptor.writable === true || typeof descriptor.set === 'function';
  expect(isAssignable).toBe(true);
});
