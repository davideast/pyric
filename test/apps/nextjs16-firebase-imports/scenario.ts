// #1443: Next 16 makes Turbopack the default for `next dev`, and Turbopack
// imports server externals under a renamed package root
// (`firebase-admin-<16 hex>/app`). A route handler under
// `pyric sandbox -- next dev` must still reach the sandbox through
// `firebase-admin` and the client `firebase` SDK, with Turbopack, with
// `--hosted`, and with `--webpack` as the control. See
// `../nextjs-firebase-imports.ts` for the app and the safety preload that keeps
// every case on this machine.
import { scenario } from '../driver.ts';
import { runFirebaseImports } from '../nextjs-firebase-imports.ts';

export default scenario((app) => runFirebaseImports(app, [
  { name: 'pyric sandbox -- next dev', nextFlags: [], hosted: false },
  { name: 'pyric sandbox --hosted -- next dev', nextFlags: [], hosted: true },
  { name: 'pyric sandbox -- next dev --webpack', nextFlags: ['--webpack'], hosted: false },
]));
