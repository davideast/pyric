// #1443: the Next 15 side of `nextjs16-firebase-imports`. Next 15 runs webpack
// by default and Turbopack with `--turbopack`; neither renames server
// externals, and both must keep reaching the sandbox. See
// `../nextjs-firebase-imports.ts` for the app and the safety preload. #1637:
// the same app in production AI mode, on both bundlers, gets the Firebase
// SDK's `firebase/ai`; see `../nextjs-production-ai.ts`.
//
// package.json matches `nextjs-template`'s, name included, so the runner
// installs the two apps once.
import { scenario } from '../driver.ts';
import { runFirebaseImports } from '../nextjs-firebase-imports.ts';
import { productionAiCases } from '../nextjs-production-ai.ts';

export default scenario((app) => runFirebaseImports(app, [
  { name: 'pyric sandbox -- next dev', nextFlags: [], hosted: false },
  { name: 'pyric sandbox -- next dev --turbopack', nextFlags: ['--turbopack'], hosted: false },
], { extraCases: productionAiCases([[], ['--turbopack']]) }));
