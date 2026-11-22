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
  const prevLocation = globalThis.location;
  const prevFetch = globalThis.fetch;
  let postCount = 0;
  Object.defineProperty(globalThis, 'location', {
    value: dom.window.location,
    configurable: true,
  });
  globalThis.fetch = (async () => {
    postCount += 1;
    return new Response('forbidden', { status: 403 });
  }) as typeof fetch;
  cleanups.push(() => {
    Object.defineProperty(globalThis, 'location', {
      value: prevLocation,
      configurable: true,
    });
    globalThis.fetch = prevFetch;
    dom.window.close();
  });

  recordDiagnostic({ phase: 'init-request' });
  stopDiagnosticReporting();
  recordDiagnostic({ phase: 'init-failed' });
  await new Promise(resolve => setTimeout(resolve, 160));

  expect(postCount).toBe(0);
  expect(globalThis.__pyricDiagnostics?.getSnapshot().events).toHaveLength(2);
});
