import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserContext } from '@playwright/test';
import { CrashWatch, describeCrashes, findProcessCrashes, readWorkerReport, WORKER_REPORT_MARKER, type ExpectedCrash } from './crash-watch.ts';

const PYRIC_FRAME = '    at handle (/tmp/pyric-app-x/app/node_modules/@pyric/cli/dist/serve/server.js:12:3)';
const APP_FRAME = '    at main (/tmp/pyric-app-x/app/server.mjs:4:9)';

const nodeUncaught = (frame: string) => [
  'listening on 4000',
  '/tmp/pyric-app-x/app/node_modules/@pyric/cli/dist/serve/server.js:12',
  "    throw new TypeError('boom');",
  '    ^',
  '',
  'TypeError: boom',
  frame,
  '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
  '',
  'Node.js v24.16.0',
  '',
].join('\n');

const nodeRejection = [
  'node:internal/process/promises:394',
  '    triggerUncaughtException(err, true /* fromPromise */);',
  '    ^',
  '',
  '[UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "nope".] {',
  "  code: 'ERR_UNHANDLED_REJECTION'",
  '}',
  '',
  'Node.js v24.16.0',
].join('\n');

describe('findProcessCrashes', () => {
  test("reads Node's uncaught exception with a Pyric frame", () => {
    const [crash, ...rest] = findProcessCrashes(nodeUncaught(PYRIC_FRAME));
    expect(rest).toEqual([]);
    expect(crash!.kind).toBe('uncaught exception');
    expect(crash!.message).toBe('TypeError: boom');
    expect(crash!.stack[0]).toBe(PYRIC_FRAME);
  });

  test("leaves out an uncaught exception from the app's own code", () => {
    const appCrash = nodeUncaught(APP_FRAME).replace('node_modules/@pyric/cli/dist/serve/server.js', 'server.mjs');
    expect(findProcessCrashes(appCrash)).toEqual([]);
  });

  test("reads Node's unhandled rejection of a non-Error reason, which has no frames", () => {
    const [crash] = findProcessCrashes(nodeRejection);
    expect(crash!.kind).toBe('unhandled rejection');
    expect(crash!.message).toStartWith('[UnhandledPromiseRejection:');
  });

  test("reads the sandbox guard's report and its indented stack", () => {
    const output = [
      '  ✖ pyric sandbox: unhandled rejection. The server was kept alive. Please report this:',
      '    Error: socket hang up',
      `    ${PYRIC_FRAME.trim()}`,
      'next line',
    ].join('\n');
    expect(findProcessCrashes(output)).toEqual([
      { kind: 'pyric sandbox unhandled rejection', message: 'Error: socket hang up', stack: [PYRIC_FRAME.trim()] },
    ]);
  });

  test("reads the functions host's report only when the stack is Pyric's", () => {
    const pyric = `✖ functions uncaught exception, kept serving: Error: tick\n${PYRIC_FRAME}\n`;
    const app = `✖ functions uncaught exception, kept serving: Error: tick\n${APP_FRAME}\n`;
    expect(findProcessCrashes(pyric).map((crash) => crash.message)).toEqual(['Error: tick']);
    expect(findProcessCrashes(app)).toEqual([]);
  });

  test("reads the host request handler's 500 line", () => {
    expect(findProcessCrashes('  ✖ 500 /__pyric/init.json: Cannot read properties of undefined\n')).toEqual([
      { kind: 'host request handler threw', message: 'Cannot read properties of undefined', stack: ['request /__pyric/init.json'] },
    ]);
  });

  test('finds nothing in ordinary output', () => {
    expect(findProcessCrashes('  VITE v6 ready\n  ✔ [pyric] function hello\nError: denied by rules\n')).toEqual([]);
  });
});

describe('readWorkerReport', () => {
  test("reads a service worker's report", () => {
    const text = WORKER_REPORT_MARKER + JSON.stringify({ kind: 'unhandled rejection', message: 'x', stack: 'Error: x\n    at sw.js:1:1' });
    expect(readWorkerReport(text)).toEqual({ kind: 'service worker unhandled rejection', message: 'Error: x', stack: ['    at sw.js:1:1'] });
  });

  test('ignores other console lines', () => {
    expect(readWorkerReport('hello')).toBeUndefined();
  });
});

/** A context, page, and service worker that emit the events the watch listens for. */
function fakeContext() {
  const context = new EventEmitter();
  const page = Object.assign(new EventEmitter(), { url: () => 'http://127.0.0.1:5173/' });
  const evaluated: string[] = [];
  const worker = Object.assign(new EventEmitter(), {
    url: () => 'http://127.0.0.1:5173/sw.js',
    evaluate: async (_fn: unknown, marker: string) => { evaluated.push(marker); },
  });
  Object.assign(context, { pages: () => [page], serviceWorkers: () => [] });
  return { context, asContext: context as unknown as BrowserContext, page, worker, evaluated };
}

function webError(error: Error) {
  return { error: () => error, page: () => ({ url: () => 'http://127.0.0.1:5173/' }), location: () => ({ url: 'http://127.0.0.1:5173/main.js', line: 7, column: 2 }) };
}

describe('CrashWatch', () => {
  test('records page errors, renderer crashes, and service worker reports with the step they happened in', async () => {
    let step = 'open the page';
    const watch = new CrashWatch(() => step);
    const fake = fakeContext();
    watch.watchContext(fake.asContext);
    fake.context.emit('weberror', webError(new TypeError('undefined is not a function')));
    step = 'reload';
    fake.page.emit('crash');
    fake.context.emit('serviceworker', fake.worker);
    await Promise.resolve();
    expect(fake.evaluated).toEqual([WORKER_REPORT_MARKER]);
    fake.worker.emit('console', { text: () => WORKER_REPORT_MARKER + JSON.stringify({ kind: 'uncaught exception', message: 'sw', stack: '' }) });
    fake.worker.emit('console', { text: () => 'an ordinary log' });

    const crashes = watch.unexpected([], []);
    expect(crashes.map(({ kind, source, step: during, message }) => ({ kind, source, during, message }))).toEqual([
      { kind: 'page error', source: 'page http://127.0.0.1:5173/ (at http://127.0.0.1:5173/main.js:7)', during: 'open the page', message: 'TypeError: undefined is not a function' },
      { kind: 'page crash', source: 'page http://127.0.0.1:5173/', during: 'reload', message: "the page's renderer crashed" },
      { kind: 'service worker uncaught exception', source: 'service worker http://127.0.0.1:5173/sw.js', during: 'reload', message: 'sw' },
    ]);
  });

  test('a page opened after the watch starts is watched too', () => {
    const watch = new CrashWatch(() => 'step');
    const fake = fakeContext();
    watch.watchContext(fake.asContext);
    const later = Object.assign(new EventEmitter(), { url: () => 'http://127.0.0.1:5173/second' });
    fake.context.emit('page', later);
    later.emit('crash');
    expect(watch.unexpected([], []).map((crash) => crash.source)).toEqual(['page http://127.0.0.1:5173/second']);
  });

  test('an expected crash must match both its message and its source', () => {
    const watch = new CrashWatch(() => 'step');
    const fake = fakeContext();
    watch.watchContext(fake.asContext);
    fake.context.emit('weberror', webError(new Error('refused: no register')));
    const processes = [{ name: 'server script 1 (refuse.mjs)', output: nodeUncaught(PYRIC_FRAME) }];
    const expected: ExpectedCrash[] = [
      { message: /refused: no register/, source: /^page /, reason: 'the page provokes the refusal' },
      { message: /boom/, source: /^dev server$/, reason: 'a different process' },
    ];
    const left = watch.unexpected(expected, processes);
    expect(left.map((crash) => `${crash.source}: ${crash.message}`)).toEqual(['server script 1 (refuse.mjs): TypeError: boom']);
  });

  test('the failure text names each crash, where, and the head of its stack', () => {
    const text = describeCrashes([
      { kind: 'page error', source: 'page http://x/', step: 'load', message: 'Error: a', stack: Array.from({ length: 8 }, (_, i) => `    at f${i} (x.js)`) },
      { kind: 'uncaught exception', source: 'dev server', step: '', message: 'Error: b', stack: [] },
    ]);
    expect(text).toContain('2 crashes the scenario did not expect:');
    expect(text).toContain('- page error in page http://x/, during "load": Error: a');
    expect(text).toContain('    at f5 (x.js)');
    expect(text).not.toContain('at f6');
    expect(text).toContain('... 2 more lines');
    expect(text).toContain('- uncaught exception in dev server: Error: b');
    expect(text).toContain('expectedCrashes');
  });
});
