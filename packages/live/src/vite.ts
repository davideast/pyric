/**
 * `@pyric/live/vite`: live mode for a Vite page. The page's `firebase/app`,
 * `firebase/auth`, `firebase/firestore` and `firebase/app-check` are the
 * app's own installed SDK, wrapped by the live rows, so the app talks to its
 * real project. Each wrapped Firestore and Auth call's outcome reaches the
 * Node host as an observed call, and the chip shows it as production's row.
 * Every other served Firebase import is refused (`refusal.ts`).
 *
 *   import { pyricLive } from '@pyric/live/vite';
 *   export default defineConfig({ plugins: [pyricLive()] });
 *
 * It is `@pyric/cli`'s plugin on the Node host (`hosted: true`) with the live
 * rows, through the one internal seam. The seam loads the row modules'
 * source from this package as the project installs it (`page-modules.ts`),
 * so nothing in `pyric` or `@pyric/cli` opens the rows without it.
 */
import { pyricWithSuppliedRows, type PyricOptions } from '@pyric/cli/vite/internal/supplied-rows';
import { liveRefusal } from './refusal.js';

type PyricPlugin = ReturnType<typeof pyricWithSuppliedRows>;

/** The plugin options live mode takes: `@pyric/cli`'s, always on the Node host. */
export type PyricLiveOptions = Omit<PyricOptions, 'hosted' | 'swapInBuild'>;

/** Whether Vite runs the dev server: live mode never applies to a build or a preview. */
function isDevServer(_config: unknown, env: { command: string; isPreview?: boolean }): boolean {
  return env.command === 'serve' && env.isPreview !== true;
}

/** Live mode for `vite dev`. */
export function pyricLive(options: PyricLiveOptions = {}): PyricPlugin {
  const hosted = pyricWithSuppliedRows({ ...options, hosted: true }, { refusal: liveRefusal });
  return { ...hosted, apply: isDevServer };
}
