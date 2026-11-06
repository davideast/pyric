import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { BrowserContext } from '@playwright/test';
import type { TargetCrash } from './crash-targets.ts';
import { checkExpectedCrashes, CrashWatch, describeVerdict, isFailing, type ExpectedCrash } from './crash-watch.ts';

const NODE_CRASH = [
  'file:///tmp/pyric-app-x/app/server.mjs:4',
  'cred.user.missingField.read;',
  '                       ^',
  '',
  "TypeError: Cannot read properties of undefined (reading 'read')",
  '    at main (file:///tmp/pyric-app-x/app/server.mjs:4:24)',
  '',
  'Node.js v24.16.0',
].join('\n');

/** A context and page that emit the events the watch listens for, and a stand-in worker watch. */
function fakeContext() {
  const context = new EventEmitter();
  const page = Object.assign(new EventEmitter(), { url: () => 'http://127.0.0.1:5173/' });
  Object.assign(context, { pages: () => [page] });
  let reportWorkerCrash: (crash: TargetCrash) => void = () => {};
  const watchWorkers = async (_context: BrowserContext, record: (crash: TargetCrash) => void) => { reportWorkerCrash = record; };
  return { context, asContext: context as unknown as BrowserContext, page, watchWorkers, workerCrash: (crash: TargetCrash) => reportWorkerCrash(crash) };
}

function webError(error: Error) {
  return { error: () => error, page: () => ({ url: () => 'http://127.0.0.1:5173/' }), location: () => ({ url: 'http://127.0.0.1:5173/main.js', line: 7, column: 2 }) };
}

describe('CrashWatch', () => {
  test('records page errors, renderer crashes, and worker crashes with the step they happened in', async () => {
    let step = 'open the page';
    const fake = fakeContext();
    const watch = new CrashWatch(() => step, fake.watchWorkers);
    await watch.watchContext(fake.asContext);
    fake.context.emit('weberror', webError(new TypeError('undefined is not a function')));
    step = 'reload';
    fake.page.emit('crash');
    fake.workerCrash({ kind: 'shared worker uncaught exception', source: 'shared worker http://127.0.0.1:5173/shared.js', message: 'Error: sw', stack: [] });

    const { unexpected } = watch.verdict([], []);
    expect(unexpected.map(({ kind, source, step: during, message }) => ({ kind, source, during, message }))).toEqual([
      { kind: 'page error', source: 'page http://127.0.0.1:5173/ (at http://127.0.0.1:5173/main.js:7)', during: 'open the page', message: 'TypeError: undefined is not a function' },
      { kind: 'page crash', source: 'page http://127.0.0.1:5173/', during: 'reload', message: "the page's renderer crashed" },
      { kind: 'shared worker uncaught exception', source: 'shared worker http://127.0.0.1:5173/shared.js', during: 'reload', message: 'Error: sw' },
    ]);
  });

  test('a page opened after the watch starts is watched too', async () => {
    const fake = fakeContext();
    const watch = new CrashWatch(() => 'step', fake.watchWorkers);
    await watch.watchContext(fake.asContext);
    const later = Object.assign(new EventEmitter(), { url: () => 'http://127.0.0.1:5173/second' });
    fake.context.emit('page', later);
    later.emit('crash');
    expect(watch.verdict([], []).unexpected.map((crash) => crash.source)).toEqual(['page http://127.0.0.1:5173/second']);
  });

  test("a Node crash in a process counts, even in the app's own code", () => {
    const watch = new CrashWatch(() => 'step', fakeContext().watchWorkers);
    const { unexpected } = watch.verdict([], [{ name: 'server process 1 (server.mjs)', output: NODE_CRASH }]);
    expect(unexpected.map((crash) => `${crash.kind} in ${crash.source}: ${crash.message}`)).toEqual([
      "uncaught exception in server process 1 (server.mjs): TypeError: Cannot read properties of undefined (reading 'read')",
    ]);
  });

  test('a process that exited early with a non-zero code and printed no crash fails with its last lines', () => {
    const watch = new CrashWatch(() => 'step', fakeContext().watchWorkers);
    const processes = [
      { name: 'dev server', output: 'one\ntwo\nthree\nfour\nfive\nsix\n', earlyExitCode: 1 },
      { name: 'server process 1 (server.mjs)', output: NODE_CRASH, earlyExitCode: 1 },
      { name: 'pyric 2 (rules lint)', output: 'refused\n' },
    ];
    const { unexpected } = watch.verdict([], processes);
    expect(unexpected.map(({ kind, source, message, stack }) => ({ kind, source, message, stack: stack.length }))).toEqual([
      { kind: 'process exited early', source: 'dev server', message: 'exited with code 1 before the scenario stopped it', stack: 5 },
      { kind: 'uncaught exception', source: 'server process 1 (server.mjs)', message: "TypeError: Cannot read properties of undefined (reading 'read')", stack: 3 },
    ]);
  });

  test('an expected crash must match both its message and its source, and an entry that matches nothing is reported', async () => {
    const fake = fakeContext();
    const watch = new CrashWatch(() => 'step', fake.watchWorkers);
    await watch.watchContext(fake.asContext);
    fake.context.emit('weberror', webError(new Error('refused: no register')));
    const processes = [{ name: 'server script 1 (refuse.mjs)', output: NODE_CRASH }];
    const pageEntry: ExpectedCrash = { message: /refused: no register/, source: /^page /, reason: 'the page provokes the refusal' };
    const otherProcess: ExpectedCrash = { message: /missingField|reading 'read'/, source: /^dev server$/, reason: 'a different process' };
    const verdict = watch.verdict([pageEntry, otherProcess], processes);
    expect(verdict.unexpected.map((crash) => crash.source)).toEqual(['server script 1 (refuse.mjs)']);
    expect(verdict.unmatched).toEqual([otherProcess]);
    expect(isFailing(verdict)).toBe(true);
    expect(isFailing(watch.verdict([pageEntry, { ...otherProcess, source: /^server script/ }], processes))).toBe(false);
  });
});

describe('checkExpectedCrashes', () => {
  test('accepts entries with plain patterns and a reason', () => {
    expect(checkExpectedCrashes(undefined)).toEqual([]);
    expect(checkExpectedCrashes([{ message: /x/i, source: /^page /, reason: 'why' }])).toEqual([]);
  });

  test('rejects g and y patterns, which keep lastIndex between tests, and entries with no reason', () => {
    expect(checkExpectedCrashes([{ message: /x/g, source: /^page /y, reason: ' ' }, { message: 'x', source: /y/, reason: 'why' }])).toEqual([
      'expectedCrashes[0].message /x/g has the g flag',
      'expectedCrashes[0].source /^page /y has the y flag',
      'expectedCrashes[0] has no reason',
      'expectedCrashes[1].message is not a RegExp',
    ]);
    expect(checkExpectedCrashes({})).toEqual(['expectedCrashes is not an array']);
  });
});

describe('describeVerdict', () => {
  test('names each crash, where, and the head of its stack, then each entry that matched nothing', () => {
    const text = describeVerdict({
      unexpected: [
        { kind: 'page error', source: 'page http://x/', step: 'load', message: 'Error: a', stack: Array.from({ length: 8 }, (_, i) => `    at f${i} (x.js)`) },
        { kind: 'uncaught exception', source: 'dev server', step: '', message: 'Error: b', stack: [] },
      ],
      unmatched: [{ message: /gone/, source: /^page /, reason: 'the page used to provoke it' }],
    });
    expect(text).toContain('2 crashes the scenario did not expect:');
    expect(text).toContain('- page error in page http://x/, during "load": Error: a');
    expect(text).toContain('    at f5 (x.js)');
    expect(text).not.toContain('at f6');
    expect(text).toContain('... 2 more lines');
    expect(text).toContain('- uncaught exception in dev server: Error: b');
    expect(text).toContain('1 expectedCrashes entry matched no crash; remove each or fix its patterns:');
    expect(text).toContain('- message /gone/, source /^page / (the page used to provoke it)');
  });
});
