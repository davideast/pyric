// #1443: the Next 15 side of `nextjs16-firebase-imports`. Next 15 runs webpack
// by default and Turbopack with `--turbopack`; neither renames server
// externals, and both must keep reaching the sandbox. See
// `../nextjs-firebase-imports.ts` for the app and the safety preload.
//
// package.json matches `nextjs-template`'s, name included, so the runner
// installs the two apps once.
import { scenario } from '../driver.ts';
import { runFirebaseImports } from '../nextjs-firebase-imports.ts';

export default scenario((app) => runFirebaseImports(app, [
  { name: 'pyric sandbox -- next dev', nextFlags: [], hosted: false },
  { name: 'pyric sandbox -- next dev --turbopack', nextFlags: ['--turbopack'], hosted: false },
]));
