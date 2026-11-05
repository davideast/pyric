import { describe, expect, test } from 'bun:test';
import { findProcessCrashes } from './crash-output.ts';

const PYRIC_FRAME = '    at handle (/tmp/pyric-app-x/app/node_modules/@pyric/cli/dist/serve/server.js:12:3)';
const APP_FRAME = '    at main (file:///tmp/pyric-app-x/app/server.mjs:4:23)';

/** What Node prints for an uncaught exception thrown at `site`, with `frame` on top of the stack. */
const nodeUncaught = (site: string, frame: string) => [
  'listening on 4000',
  site,
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

/** What Node prints for an unhandled rejection whose reason is `reason`. */
const nodeRejection = (reason: string[]) => [
  'node:internal/process/promises:394',
  '    triggerUncaughtException(err, true /* fromPromise */);',
  '    ^',
  '',
  ...reason,
  '',
  'Node.js v24.16.0',
].join('\n');

describe('findProcessCrashes', () => {
  test("reads Node's uncaught exception from Pyric's code", () => {
    const [crash, ...rest] = findProcessCrashes(nodeUncaught('/tmp/pyric-app-x/app/node_modules/@pyric/cli/dist/serve/server.js:12', PYRIC_FRAME));
    expect(rest).toEqual([]);
    expect(crash!.kind).toBe('uncaught exception');
    expect(crash!.message).toBe('TypeError: boom');
    expect(crash!.stack[0]).toBe(PYRIC_FRAME);
  });

  test("reads Node's uncaught exception from the app's own code too: after an await, a Pyric bug crashes there", () => {
    const output = [
      'file:///tmp/pyric-app-x/app/server.mjs:4',
      'const missing = cred.user.missingField.read;',
      '                                       ^',
      '',
      "TypeError: Cannot read properties of undefined (reading 'read')",
      APP_FRAME,
      '',
      'Node.js v24.16.0',
    ].join('\n');
    expect(findProcessCrashes(output)).toEqual([{
      kind: 'uncaught exception',
      message: "TypeError: Cannot read properties of undefined (reading 'read')",
      stack: [APP_FRAME, 'thrown at file:///tmp/pyric-app-x/app/server.mjs:4', 'thrown at const missing = cred.user.missingField.read;'],
    }]);
  });

  test("labels Node's unhandled rejection of an Error as a rejection", () => {
    const [crash] = findProcessCrashes(nodeRejection(['Error: refused', APP_FRAME]));
    expect(crash).toEqual({ kind: 'unhandled rejection', message: 'Error: refused', stack: [APP_FRAME] });
  });

  test("labels Node's unhandled rejection of a non-Error reason, which has no frames", () => {
    const [crash] = findProcessCrashes(nodeRejection([
      '[UnhandledPromiseRejection: This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "nope".] {',
      "  code: 'ERR_UNHANDLED_REJECTION'",
      '}',
    ]));
    expect(crash!.kind).toBe('unhandled rejection');
    expect(crash!.message).toStartWith('[UnhandledPromiseRejection:');
  });

  test("reads Next.js's uncaughtException and unhandledRejection lines, which have no Node.js version line", () => {
    const output = [
      '⨯ uncaughtException:  Error: listener threw',
      APP_FRAME,
      '   ▲ Next.js 16.4.3',
      '⨯ unhandledRejection: TypeError: fetch failed',
      PYRIC_FRAME,
    ].join('\n');
    expect(findProcessCrashes(output)).toEqual([
      { kind: 'Next.js uncaught exception', message: 'Error: listener threw', stack: [APP_FRAME.trim()] },
      { kind: 'Next.js unhandled rejection', message: 'TypeError: fetch failed', stack: [PYRIC_FRAME.trim()] },
    ]);
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

  test("reads the functions host's report, whoever's frames are on its stack", () => {
    const output = `✖ functions uncaught exception, kept serving: Error: tick\n${APP_FRAME}\n`;
    expect(findProcessCrashes(output)).toEqual([{ kind: 'functions uncaught exception', message: 'Error: tick', stack: [APP_FRAME.trim()] }]);
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
