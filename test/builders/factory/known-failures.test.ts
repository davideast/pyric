// The start commit's failures excuse an hour's gate only by count, in that
// gate, and never a timeout, a kill or a failure the parse can't name.
import { describe, expect, test } from 'bun:test';
import type { GateResult } from './gates.ts';
import { excuseKnown, failureReport, knownFailuresOf } from './known-failures.ts';

const scanHit = (file: string, line = 166) => ['error[no-client-run-transaction]: Client-side runTransaction fails immediately when offline.', `    ┌─ ${file}:${line}:9`, '    │'].join('\n');
const scanOutput = (hits: string[]) => `${hits.join('\n')}\nError: ${hits.length} error(s) found in code.`;
/** bun's output: each failure where it ran, then the recap and the totals. */
const testOutput = (names: string[], extra = '') => {
  const lines = names.map((name) => `(fail) ${name} [60.79ms]`);
  const recap = names.length === 0 ? [] : [`${names.length} tests failed:`, ...lines];
  return [...lines, extra, ...recap, ' 10 pass', ` ${names.length} fail`, 'Ran 12 tests across 3 files.'].join('\n');
};
const tsError = (file: string, line: number, code = 'TS2322', message = 'Type mismatch.') => `${file}(${line},7): error ${code}: ${message}`;

const failing = (gate: GateResult['gate'], output: string, exit: GateResult['exit'] = { code: 1, timedOut: false }): GateResult => ({ gate, passed: false, summary: 'exited 1', output, exit });
const pass = (gate: GateResult['gate']): GateResult => ({ gate, passed: true, summary: 'passed' });

describe('failure signatures', () => {
  test('leave out line numbers and timings, and count the recap once', () => {
    expect([...failureReport('studio-checks', scanOutput([scanHit('src/lib/playlists.ts')])).counts]).toEqual([['no-client-run-transaction src/lib/playlists.ts', 1]]);
    expect([...failureReport('tests', testOutput(['saves music versions'])).counts]).toEqual([['saves music versions', 1]]);
    expect([...failureReport('typecheck', tsError('src/a.tsx', 3)).counts]).toEqual([['src/a.tsx TS2322: Type mismatch.', 1]]);
  });
});

describe('excuseKnown', () => {
  test('a gate failing only on what the start commit failed on passes, with the count in its summary', () => {
    const known = knownFailuresOf([failing('tests', testOutput(['a', 'b'])), pass('typecheck')]);
    expect(known).toEqual({ tests: { a: 1, b: 1 } });
    const excused = excuseKnown(failing('tests', testOutput(['b'])), known);
    expect(excused.passed).toBe(true);
    expect(excused.summary).toBe('passed apart from 1 failure the start commit already had');
    expect(excuseKnown(failing('tests', testOutput(['a', 'b'])), known).summary).toBe('passed apart from 2 failures the start commit already had');
  });

  test('a timed-out run is never excused, whatever it printed before the hang', () => {
    const known = knownFailuresOf([failing('tests', testOutput(['a']))]);
    const hung = failing('tests', '(fail) a [60.79ms]\n[runner] bun stopped after 900 s', { code: null, timedOut: true });
    expect(excuseKnown(hung, known).passed).toBe(false);
    expect(excuseKnown({ ...failing('tests', testOutput(['a'])), exit: { code: null, timedOut: false } }, known).passed).toBe(false);
  });

  test('a timed-out run is not excused even when its output is complete and exits with a code', () => {
    const known = knownFailuresOf([failing('tests', testOutput(['a']))]);
    expect(excuseKnown(failing('tests', testOutput(['a']), { code: 1, timedOut: true }), known).summary).toContain('not excused: it timed out');
  });

  test('a run with no fail total is not excused', () => {
    const known = knownFailuresOf([failing('tests', testOutput(['a']))]);
    const noTotal = testOutput(['a']).replace(' 1 fail\n', '');
    expect(excuseKnown(failing('tests', noTotal), known).summary).toContain('not excused: bun printed no fail total');
  });

  test('a test that prints its own fail total before the run ends is not excused', () => {
    const known = knownFailuresOf([failing('tests', testOutput(['a']))]);
    const spoofed = ['(fail) a [60.79ms]', ' 1 fail', 'error: script exited with code 1'].join('\n');
    expect(excuseKnown(failing('tests', spoofed), known).summary).toContain('no closing "Ran N tests" line');
    // bun's own total, the last one, counts a second failure the printed one hides.
    const early = testOutput(['a']).replace('(fail) a [60.79ms]', '(fail) a [60.79ms]\n 1 fail').replace(/ 1 fail\nRan/, ' 2 fail\nRan');
    expect(failureReport('tests', early).problems).toEqual(['bun counted 2 failed tests and 1 were named']);
    expect(excuseKnown(failing('tests', early), known).passed).toBe(false);
  });

  test('a known test failure beside an unhandled error is not excused', () => {
    const known = knownFailuresOf([failing('tests', testOutput(['a']))]);
    expect(excuseKnown(failing('tests', testOutput(['a'], '# Unhandled error between tests\nerror: Cannot find module "x"')), known).passed).toBe(false);
    expect(excuseKnown(failing('tests', testOutput(['a']).replace(' 1 fail', ' 1 fail\n 1 error')), known).passed).toBe(false);
    expect(excuseKnown(failing('tests', testOutput(['a']).replace(' 1 fail', ' 2 fail')), known).passed).toBe(false);
  });

  test('a second copy of a known type error, at a new line of the same file, is not excused', () => {
    const known = knownFailuresOf([failing('typecheck', tsError('src/a.tsx', 3))]);
    expect(excuseKnown(failing('typecheck', [tsError('src/a.tsx', 3), tsError('src/a.tsx', 40)].join('\n')), known).passed).toBe(false);
  });

  test('a new ast-grep hit in a file that already had one is not excused', () => {
    const known = knownFailuresOf([failing('studio-checks', scanOutput([scanHit('src/lib/playlists.ts')]))]);
    const twice = scanOutput([scanHit('src/lib/playlists.ts'), scanHit('src/lib/playlists.ts', 200)]);
    expect(excuseKnown(failing('studio-checks', twice), known).passed).toBe(false);
    const undercounted = `${scanHit('src/lib/playlists.ts')}\nError: 2 error(s) found in code.`;
    expect(excuseKnown(failing('studio-checks', undercounted), known).passed).toBe(false);
  });

  test('a known type error beside one with no file is not excused', () => {
    const known = knownFailuresOf([failing('typecheck', tsError('src/a.tsx', 3))]);
    const global = `${tsError('src/a.tsx', 3)}\nerror TS2688: Cannot find type definition file for 'node'.`;
    expect(excuseKnown(failing('typecheck', global), known).passed).toBe(false);
  });

  test('one known failure does not excuse new ones beside it', () => {
    const known = knownFailuresOf([failing('tests', testOutput(['a']))]);
    expect(excuseKnown(failing('tests', testOutput(['a', 'new one', 'another'])), known).passed).toBe(false);
  });

  test('a failure known in one gate does not excuse another gate', () => {
    const known = { tests: { 'no-client-run-transaction src/lib/other.ts': 1 } };
    expect(excuseKnown(failing('studio-checks', scanOutput([scanHit('src/lib/other.ts')])), known).passed).toBe(false);
  });

  test('a new failure, one with no signature, or one with no baseline still fails', () => {
    const known = knownFailuresOf([failing('studio-checks', scanOutput([scanHit('src/lib/playlists.ts')]))]);
    expect(excuseKnown(failing('studio-checks', scanOutput([scanHit('src/lib/other.ts')])), known).passed).toBe(false);
    expect(excuseKnown(failing('studio-checks', 'something broke'), known).passed).toBe(false);
    expect(excuseKnown(failing('tests', testOutput(['a'])), {}).passed).toBe(false);
  });

  test('a signature named like an object property is still counted', () => {
    const known = knownFailuresOf([failing('tests', testOutput(['a']))]);
    expect(excuseKnown(failing('tests', testOutput(['constructor'])), known).passed).toBe(false);
  });

  test('a start commit whose gate can\'t be counted records nothing for it', () => {
    expect(knownFailuresOf([failing('tests', testOutput(['a']), { code: null, timedOut: true })])).toEqual({});
  });
});
