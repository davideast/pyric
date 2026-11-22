import { JSDOM } from 'jsdom';
import { afterEach, expect, test } from 'bun:test';
import {
  recordDiagnostic,
  stopDiagnosticReporting,
} from '../../../src/serve/runtime/diagnostics-client.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  stopDiagnosticReporting(false);
  delete globalThis.__pyricDiagnostics;
  for (const cleanup of cleanups.splice(0)) cleanup();
});

test('stopDiagnosticReporting cancels scheduled HTTP flushes while keeping local events (#2056)', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://10.203.0.1:5000/' });
  const prevLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const prevFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let postCount = 0;
  Object.defineProperty(globalThis, 'location', {
    value: dom.window.location,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'fetch', {
    value: (async () => {
      postCount += 1;
      return new Response('forbidden', { status: 403 });
    }) as typeof fetch,
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

  recordDiagnostic({ phase: 'init-request' });
  stopDiagnosticReporting();
  recordDiagnostic({ phase: 'init-failed' });
  await new Promise(resolve => setTimeout(resolve, 160));

  expect(postCount).toBe(0);
  expect(globalThis.__pyricDiagnostics?.getSnapshot().events).toHaveLength(2);
});

test('cleanup restores globalThis.location without leaving it readonly', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const isAssignable =
    descriptor === undefined || descriptor.writable === true || typeof descriptor.set === 'function';
  expect(isAssignable).toBe(true);
});
