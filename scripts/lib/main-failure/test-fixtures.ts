// Shared inputs for the main failure tests: one run, its attempts, and
// excerpts of real Build & Test job logs from main.

import type { AttemptReport } from './decide.ts';
import type { Failure } from './parse-log.ts';

export const RUN = 'https://github.com/davideast/pyric/actions/runs/7';
export const SHA = '7b8dfc5701234567890abcdef1234567890abcd';
export const TESTS_JOB = 'Build all packages + run tests (2/2)';
export const SPARSE = 'test/serve/worker/client/rtdb-sparse-array-holes.test.ts > (unnamed)';

export function attempt(attemptNumber: number, conclusion: string, failures: Failure[] = []): AttemptReport {
  return { runId: 7, attempt: attemptNumber, conclusion, headSha: SHA, url: `${RUN}/attempts/${attemptNumber}`, failures };
}

export const hookTimeout: Failure = { job: TESTS_JOB, test: SPARSE, assertion: 'a beforeEach/afterEach hook timed out for this test.' };
export const packaging: Failure = { job: 'Packaging gate', assertion: 'Error: packed @pyric/cli Firebase SDK import edges drifted' };

// Excerpts of real Build & Test job logs from main.
export const HOOK_TIMEOUT_LOG = [
  '2026-10-29T03:03:58.7850000Z ##[group]test/serve/worker/client/rtdb-references.test.ts:',
  '2026-10-29T03:03:58.7851000Z (pass) RTDB worker references > validates ref and child paths [4.00ms]',
  '2026-10-29T03:03:58.7852000Z ##[endgroup]',
  '2026-10-29T03:03:58.7853000Z ##[group]test/serve/worker/client/rtdb-sparse-array-holes.test.ts:',
  '2026-10-29T03:03:58.7854827Z (fail) (unnamed) [5001.01ms]',
  '2026-10-29T03:03:58.7855000Z   ^ a beforeEach/afterEach hook timed out for this test.',
  '2026-10-29T03:03:58.7856000Z ##[endgroup]',
  '2026-10-29T03:04:19.1320000Z 1 tests failed:',
  '2026-10-29T03:04:19.1328008Z (fail) (unnamed) [5001.01ms]',
  '2026-10-29T03:04:19.2645009Z ##[error]Process completed with exit code 1.',
].join('\n');

export const ASSERTION_LOG = [
  '2026-10-27T07:55:11.8897130Z ##[group]test/apps/unreaped-exit.test.ts:',
  '2026-10-27T07:55:11.8917476Z (pass) reading an unreaped exit from /proc > the fields come from their places',
  '2026-10-27T07:55:12.9082460Z Error: noise a passing test logged',
  '2026-10-27T07:55:12.9082461Z (pass) reading an unreaped exit from /proc > a waitpid status gives an exit code',
  '2026-10-27T07:55:12.9084602Z 57 |     expect(unreapedExit(await zombie(3))).toEqual({ code: 3, signal: null });',
  '2026-10-27T07:55:12.9084884Z                                                ^',
  '2026-10-27T07:55:12.9085101Z error: expect(received).toEqual(expected)',
  '2026-10-27T07:55:12.9086389Z + undefined',
  '2026-10-27T07:55:12.9087182Z       at <anonymous> (/home/runner/work/pyric/pyric/test/apps/unreaped-exit.test.ts:57:43)',
  '2026-10-27T07:55:12.9102860Z ##[error]- {',
  '      at <anonymous> (/home/runner/work/pyric/pyric/test/apps/unreaped-exit.test.ts:57:43)',
  '2026-10-27T07:55:12.9108250Z (fail) reading an unreaped exit from /proc > a running process has no exit, and a zombie has its own [1017.02ms]',
  '2026-10-27T07:55:12.9108941Z (pass) reading an unreaped exit from /proc > a zombie leader thread has not exited',
  '2026-10-27T07:55:52.7358899Z 1 tests failed:',
].join('\n');

export const PACKAGING_LOG = [
  '2026-10-28T17:58:39.3585106Z   ✓ packed CLI dependency closure installs without firebase or firebase-admin',
  '2026-10-28T17:58:41.8636408Z         ^',
  '2026-10-28T17:58:41.8637150Z Error: packed @pyric/cli Firebase SDK import edges drifted',
  '2026-10-28T17:58:41.8642343Z     at fail (file:///home/runner/work/pyric/pyric/scripts/audit-packed-cli.mjs:118:9)',
  '2026-10-28T17:58:41.8910668Z ✗ packaging gate FAILED — work dir preserved for debugging:',
  '2026-10-28T17:58:41.8920000Z error: script "test:packaging" exited with code 1',
  '2026-10-28T17:58:41.8929866Z ##[error]Process completed with exit code 1.',
].join('\n');
