/**
 * Proves that listener attribution costs the production build nothing.
 *
 * The app calls `useListenerOwner` from `@pyric/ui/listener-owner` to name
 * the React component that owns each Firestore listener. That hook gates its
 * capture on `process.env.NODE_ENV`, and `@pyric/cli/vite` swaps `firebase/*`
 * to pyric only outside production mode. Both claims are checked here by
 * building the app twice and reading the emitted JavaScript.
 *
 * Two markers are read:
 *
 * - `pyric`, which appears throughout the sandbox implementation. A
 *   production bundle must not contain it anywhere.
 * - the string `/node_modules/`, the frame filter the hook uses when it reads
 *   a render-phase call stack. It is present only when the capture survived
 *   the build, so it stands in for the capture itself.
 *
 * A production build must carry neither. A development-mode build, the one
 * `npm run build:sandbox` produces for serving under `pyric sandbox`, must
 * carry both, which is what makes the production result evidence of the gate
 * rather than of a marker that never existed.
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PYRIC_MARKER = 'pyric';
const CAPTURE_MARKER = '/node_modules/';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const templateDirectory = join(scriptDirectory, '..');

/** Build the app in `mode` into its own directory and return the emitted
 *  application JavaScript, the service worker excluded. */
async function buildAndRead(mode: string, outDirectory: string): Promise<string> {
  execFileSync(
    'npx',
    ['vite', 'build', '--mode', mode, '--emptyOutDir', '--outDir', outDirectory],
    { cwd: templateDirectory, stdio: 'inherit' },
  );
  const assetsDirectory = join(templateDirectory, outDirectory, 'assets');
  const names = (await readdir(assetsDirectory)).filter(
    (name) => name.endsWith('.js') && !name.startsWith('firebase-messaging-sw-'),
  );
  if (names.length === 0) {
    throw new Error(`The ${mode} build emitted no application JavaScript.`);
  }
  const sources = await Promise.all(
    names.map((name) => readFile(join(assetsDirectory, name), 'utf8')),
  );
  return sources.join('\n');
}

const production = await buildAndRead('production', 'dist/listener-owner-check/production');

if (production.includes(PYRIC_MARKER)) {
  throw new Error('The production bundle contains pyric.');
}
if (production.includes(CAPTURE_MARKER)) {
  throw new Error('The production bundle contains the listener-owner stack capture.');
}

const development = await buildAndRead('development', 'dist/listener-owner-check/development');

if (!development.includes(PYRIC_MARKER)) {
  throw new Error('The development-mode bundle does not contain pyric, so the production result proves nothing.');
}
if (!development.includes(CAPTURE_MARKER)) {
  throw new Error('The development-mode bundle does not contain the listener-owner stack capture, so the production result proves nothing.');
}

console.log('Listener owner build checks passed: pyric and the stack capture are in the development build and absent from the production build.');
