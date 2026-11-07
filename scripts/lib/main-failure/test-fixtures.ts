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

// Excerpts of real App scenarios job logs from main (test/apps/run.ts). Each
// failing app prints one block, headed `━━━ ✗ <app>: step "<step>" failed ━━━`,
// with its error and then its process logs under `─── <app> › <log> ───`.

// Run 42326187469, attempt 1, App scenarios (2/7): a failed assertion in a step.
export const APP_STEP_LOG = [
  '2026-11-07T01:55:50.1713512Z ✓ functions-http-hosted (32.2s)',
  '2026-11-07T01:55:51.9230901Z ✓ mcp-call-reaches-shared-worker-page (32.1s)',
  '2026-11-07T01:55:52.8455526Z ',
  '2026-11-07T01:55:52.8535987Z ━━━ ✗ ai-app-check-stays-local: step "the watch sees a SharedWorker request to an outside host, and it stays on the machine" failed ━━━',
  '2026-11-07T01:55:52.8537524Z AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:',
  '2026-11-07T01:55:52.8566650Z + actual - expected',
  '2026-11-07T01:55:52.8588447Z ',
  '2026-11-07T01:55:52.8616832Z + []',
  '2026-11-07T01:55:52.8646425Z - [',
  '2026-11-07T01:55:52.8646887Z -   {',
  '2026-11-07T01:55:52.8677795Z -     kind: \'request\',',
  '2026-11-07T01:55:52.8715788Z -     targetType: \'shared_worker\',',
  '2026-11-07T01:55:52.8745766Z -     url: \'https://egress-control.invalid/ai-app-check-stays-local\'',
  '2026-11-07T01:55:52.8746444Z -   }',
  '2026-11-07T01:55:52.8775589Z - ]',
  '2026-11-07T01:55:52.8805858Z ',
  '2026-11-07T01:55:52.8835862Z     at <anonymous> (/home/runner/work/pyric/pyric/test/apps/ai-app-check-stays-local/scenario.ts:196:14)',
  '2026-11-07T01:55:52.8836686Z     at processTicksAndRejections (native:7:39)',
  '2026-11-07T01:55:52.8865312Z ',
  '2026-11-07T01:55:52.8895913Z ─── ai-app-check-stays-local › npm install ───',
  '2026-11-07T01:55:52.8896651Z [runner] shared install c4a5789ee11a1261, made for this app',
  '2026-11-07T01:55:52.8926025Z [runner] warming store entry b272ea68326473e583bac413 from the registry',
  '2026-11-07T01:56:55.6666865Z ✗ 1 of 11 apps failed (146.4s): ai-app-check-stays-local at "the watch sees a SharedWorker request to an outside host, and it stays on the machine"; skipped 4 slow apps (hidden-tab-keeps-host',
  '2026-11-07T01:56:55.6964756Z ##[error]Process completed with exit code 1.',
].join('\n');

// Run 42033718725, attempt 1, App scenarios (2/7): Chromium did not launch in
// time, and the runner crashed after the block, so no summary line follows.
export const APP_TIMEOUT_LOG = [
  '2026-11-05T13:30:09.3710730Z ',
  '2026-11-05T13:30:09.3712099Z ━━━ ✗ nextjs16-firebase-imports: step "pyric sandbox -- next dev: the page listens to the sandbox" failed ━━━',
  '2026-11-05T13:30:09.3712825Z launch: Timeout 180000ms exceeded.',
  '2026-11-05T13:30:09.3713162Z Call log:',
  '2026-11-05T13:30:09.3727480Z   - <launching> /home/runner/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell --disable-field-trial-config --disable-background-networking',
  '2026-11-05T13:30:09.3737265Z   - <launched> pid=3520',
  '2026-11-05T13:30:09.3737949Z   - [pid=3520][err] [1105/133005.810491:WARNING:media/gpu/vaapi/vaapi_wrapper.cc:1655] drmGetDevices2() has not found any devices',
  '2026-11-05T13:30:09.3739063Z   - [pid=3520][err] [1105/133005.811813:WARNING:sandbox/policy/linux/sandbox_linux.cc:405] InitializeSandbox() called with multiple threads in process gpu-process.',
  '2026-11-05T13:30:09.3739696Z ',
  '2026-11-05T13:30:09.3739959Z     at launch (/home/runner/work/pyric/pyric/test/apps/run.ts:355:37)',
  '2026-11-05T13:30:09.3740528Z     at browser (/home/runner/work/pyric/pyric/test/apps/driver.ts:818:32)',
  '2026-11-05T13:30:09.3741330Z     at page (/home/runner/work/pyric/pyric/test/apps/driver.ts:827:32)',
  '2026-11-05T13:30:09.3742014Z     at <anonymous> (/home/runner/work/pyric/pyric/test/apps/nextjs-firebase-imports.ts:467:30)',
  '2026-11-05T13:30:09.3742656Z     at step (/home/runner/work/pyric/pyric/test/apps/driver.ts:595:20)',
  '2026-11-05T13:30:09.3743280Z     at runCase (/home/runner/work/pyric/pyric/test/apps/nextjs-firebase-imports.ts:466:26)',
  '2026-11-05T13:30:09.3744069Z     at async runFirebaseImports (/home/runner/work/pyric/pyric/test/apps/nextjs-firebase-imports.ts:601:41)',
  '2026-11-05T13:30:09.3744695Z     at processTicksAndRejections (native:7:39)',
  '2026-11-05T13:30:09.3744942Z ',
  '2026-11-05T13:30:09.3745300Z ─── nextjs16-firebase-imports › npm install ───',
  '2026-11-05T13:30:09.3745800Z [runner] shared install 171cbf9a9db3af46, made for this app',
  '2026-11-05T13:30:12.3932853Z       at processTicksAndRejections (native:7:39)',
  '2026-11-05T13:30:12.3933101Z ',
  '2026-11-05T13:30:12.3933238Z Bun v1.3.11 (Linux x64)',
  '2026-11-05T13:30:12.4007349Z ##[error]Process completed with exit code 1.',
].join('\n');

// Run 41174493690, attempt 1, App scenarios (1/7): the app failed in npm
// install, before its scenario started.
export const APP_INSTALL_LOG = [
  '2026-10-31T05:59:53.8854549Z ',
  '2026-10-31T05:59:53.8856206Z ━━━ ✗ rtdb-legacy-default-url: step "npm install" failed ━━━',
  '2026-10-31T05:59:53.8857393Z Error: npm install exited with code 1',
  '2026-10-31T05:59:53.8858682Z     at runApp (/home/runner/work/pyric/pyric/test/apps/run.ts:170:70)',
  '2026-10-31T05:59:53.8859998Z     at async <anonymous> (/home/runner/work/pyric/pyric/test/apps/run.ts:348:28)',
  '2026-10-31T05:59:53.8864304Z     at async <anonymous> (/home/runner/work/pyric/pyric/test/apps/run.ts:268:30)',
  '2026-10-31T05:59:53.8865997Z     at async pool (/home/runner/work/pyric/pyric/test/apps/run.ts:271:17)',
  '2026-10-31T05:59:53.8867322Z     at async main (/home/runner/work/pyric/pyric/test/apps/run.ts:347:21)',
  '2026-10-31T05:59:53.8868403Z     at processTicksAndRejections (native:7:39)',
  '2026-10-31T05:59:53.8869038Z ',
].join('\n');

// Run 41174493690, attempt 1, App scenarios (5/7): a failed assertion.
export const APP_ROLES_LOG = [
  '2026-10-31T05:59:57.2033933Z ',
  '2026-10-31T05:59:57.2035803Z ━━━ ✗ ai-sandbox-contents-roles: step "the SharedWorker sandbox accepts an assistant turn and refuses a system turn" failed ━━━',
  '2026-10-31T05:59:57.2037627Z AssertionError [ERR_ASSERTION]: The input did not match the regular expression /Role \'system\' is not supported. Please use a valid role: MODEL, USER.\\s+model: .*\\s+INVALID_ARGUMENT \\(400\\)/. ',
  '2026-10-31T05:59:57.2038492Z ',
  '2026-10-31T05:59:57.2039414Z "  • [pyric] ai: no engine configured; the served page\'s getAI() picks one; /__pyric/ai-proxy → http://localhost:11434/v1 (default)\\n" +',
  '2026-10-31T05:59:57.2040219Z   \'\\n\' +',
  '2026-10-31T05:59:57.2040554Z   \'  VITE v7.3.2  ready in 4189 ms\\n\' +',
  '2026-10-31T05:59:57.2040933Z   \'\\n\' +',
  '2026-10-31T05:59:57.2041358Z   \'  ➜  Local:   http://127.0.0.1:44635/\\n\' +',
  '2026-10-31T05:59:57.2041734Z   \'\'',
  '2026-10-31T05:59:57.2041882Z ',
  '2026-10-31T05:59:57.2042554Z     at checkPlane (/home/runner/work/pyric/pyric/test/apps/ai-sandbox-contents-roles/scenario.ts:33:10)',
  '2026-10-31T05:59:57.2043320Z     at processTicksAndRejections (native:7:39)',
  '2026-10-31T05:59:57.2043629Z ',
  '2026-10-31T05:59:57.2043979Z ─── ai-sandbox-contents-roles › npm install ───',
  '2026-10-31T06:00:57.7715993Z ✗ 1 of 7 apps failed (119.2s): ai-sandbox-contents-roles at "the SharedWorker sandbox accepts an assistant turn and refuses a system turn"; skipped 2 slow apps (host-closes-silent-consumer, h',
  '2026-10-31T06:00:57.8027721Z ##[error]Process completed with exit code 1.',
].join('\n');
