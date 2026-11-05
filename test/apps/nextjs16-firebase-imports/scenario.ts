// #1443: Next 16 makes Turbopack the default for `next dev`, and Turbopack
// imports server externals under a renamed package root
// (`firebase-admin-<16 hex>/app`). A route handler under
// `pyric sandbox -- next dev` must still reach the sandbox through
// `firebase-admin` and the client `firebase` SDK, with Turbopack, with
// `--hosted`, and with `--webpack` as the control. See
// `../nextjs-firebase-imports.ts` for the app and the safety preload that keeps
// every case on this machine. It then checks that `withPyric` refuses to start
// Next when `PYRIC_SANDBOX` is set but the register isn't active (#1625).
// #1637: the same app in production AI mode, on both bundlers, gets the
// Firebase SDK's `firebase/ai`; see `../nextjs-production-ai.ts`.
import { scenario, type ExpectedCrash } from '../driver.ts';
import { runFirebaseImports } from '../nextjs-firebase-imports.ts';
import { productionAiCases } from '../nextjs-production-ai.ts';

export const expectedCrashes: ExpectedCrash[] = [
  {
    message: /^exited with code 1 before the scenario stopped it$/,
    source: /^pyric \d+ \(sandbox --no-open --port \d+ -- next dev --port \d+ --hostname 127\.0\.0\.1\)$/,
    reason: 'the NODE_ENV=production refusal case runs next dev without the register, and withPyric refuses to start it',
  },
  {
    message: /^exited with code 1 before the scenario stopped it$/,
    source: /^pyric \d+ \(sandbox --no-open --port \d+ -- npm run dev\)$/,
    reason: 'the npm run dev refusal case sets its own NODE_OPTIONS, which drops the register, and withPyric refuses to start it',
  },
];

export default scenario((app) => runFirebaseImports(app, [
  { name: 'pyric sandbox -- next dev', nextFlags: [], hosted: false },
  { name: 'pyric sandbox --hosted -- next dev', nextFlags: [], hosted: true },
  // #1475: warn no longer opens a token endpoint or lets a real SDK load.
  { name: 'PYRIC_GUARD=warn pyric sandbox -- next dev --webpack', nextFlags: ['--webpack'], hosted: false, guard: 'warn' },
], { refusals: true, extraCases: productionAiCases([[], ['--webpack']]) }));
