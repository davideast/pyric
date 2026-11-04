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
 * It is `@pyric/cli`'s plugin on the Node host (`hosted: true`), given the
 * live rows through the one internal seam. Nothing in `pyric` or
 * `@pyric/cli` selects live mode: this entry is the only way in.
 */
import {
  observedCallSenderEntry,
  pyricWithSuppliedRows,
  type PyricOptions,
  type ServedFirebaseSpecifier,
} from '@pyric/cli/vite/internal/supplied-rows';
import { LIVE_OBSERVER_ID, LIVE_OBSERVER_SPECIFIER, liveModuleId, liveModuleSource, liveSourceDir } from './page-modules.js';
import { liveRefusal } from './refusal.js';
import { LIVE_ROWS } from './rows.js';

type PyricPlugin = ReturnType<typeof pyricWithSuppliedRows>;

/** The plugin options live mode takes: `@pyric/cli`'s, always on the Node host. */
export type PyricLiveOptions = Omit<PyricOptions, 'hosted' | 'swapInBuild'>;

/** The part of a Vite config this plugin changes, typed locally so the package needs no `vite` types. */
interface LiveConfig {
  readonly server?: { readonly fs?: { readonly allow?: unknown } };
}

/** The live rows as the page modules that serve them. */
function liveModules(): ReadonlyMap<ServedFirebaseSpecifier, string> {
  return new Map([...LIVE_ROWS.keys()].map((specifier) => [specifier, liveModuleId(specifier)]));
}

/** The @firebase packages the installed SDK's Auth and Firestore load, kept out of the optimizer like the rest. */
const INSTALLED_SDK_PACKAGES = ['@firebase/auth', '@firebase/firestore'];

/** Serves the live page modules and lets the page load this package's files. */
function livePagePlugin(): { name: string; enforce: 'pre'; apply: 'serve'; [hook: string]: unknown } {
  const senderFile = observedCallSenderEntry();
  return {
    name: 'pyric:live',
    enforce: 'pre',
    apply: 'serve',
    config() {
      return { optimizeDeps: { exclude: INSTALLED_SDK_PACKAGES } };
    },
    configResolved(config: LiveConfig) {
      const allow = config.server?.fs?.allow;
      const isList = Array.isArray(allow);
      if (isList && !allow.includes(liveSourceDir())) allow.push(liveSourceDir());
    },
    resolveId(source: string) {
      return source === LIVE_OBSERVER_SPECIFIER ? LIVE_OBSERVER_ID : null;
    },
    load(id: string) {
      return liveModuleSource(id, senderFile);
    },
  };
}

/** Live mode for `vite dev`. A build or a preview gets neither plugin. */
export function pyricLive(options: PyricLiveOptions = {}): [ReturnType<typeof livePagePlugin>, PyricPlugin] {
  const hosted = pyricWithSuppliedRows({ ...options, hosted: true }, { modules: liveModules(), refusal: liveRefusal });
  const devServerOnly = (_config: unknown, env: { command: string; isPreview?: boolean }) =>
    env.command === 'serve' && env.isPreview !== true;
  return [livePagePlugin(), { ...hosted, apply: devServerOnly }];
}
