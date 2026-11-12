/**
 * `@pyric/live/vite`: live mode for a Vite page. The page's `firebase/app`,
 * `firebase/auth`, `firebase/firestore`, `firebase/app-check`,
 * `firebase/database`, `firebase/ai` and `firebase/storage` are the app's
 * own installed SDK, wrapped by the live rows, so the app talks to its real
 * project. Each wrapped Firestore, Auth, Realtime Database, AI Logic and
 * Cloud Storage call's outcome reaches the Node host as an observed call,
 * and the chip shows it as production's row. Every other served
 * Firebase import is refused (`refusal.ts`), unless the app lists it in
 * `passThrough`: then it is the app's installed SDK, unwrapped and
 * unobserved, and the start line, the chip and Studio say so. A list that
 * names an import live mode serves stops the dev server at start.
 *
 *   pyricLive({ passThrough: ['firebase/functions', 'firebase/remote-config'] })
 *
 * The first time a page asks for an unserved import that is not listed, the
 * dev server names every one asked for so far and the `passThrough` option
 * that would let each load. It does so at the first transform that resolves
 * the import, not by scanning the app at start: Vite's own scan of the
 * import graph is skipped when its dependency cache is current.
 *
 *   import { pyricLive } from '@pyric/live/vite';
 *   export default defineConfig({ plugins: [pyricLive()] });
 *
 * It is `@pyric/cli`'s plugin on the Node host (`hosted: true`) with the live
 * rows, through the one internal seam. The seam loads the row modules'
 * source from this package (`page-modules.ts`): the copy this file is part
 * of, which may be installed beside the app rather than in it, or else the
 * one the Vite root resolves. So nothing in `pyric` or `@pyric/cli` opens the
 * rows without it. The dev server is the Node host: a Node process under
 * `@pyric/live/register` finds it through the project's `.pyric/serve.json`,
 * as it finds the host `pyric-live` starts.
 *
 * The dev server refuses to start when a start check fails
 * (`start-checks.ts`) or no project is set, and prints the start line once
 * it serves. The rows it serves refuse a call whose app names another
 * project than the one it resolved (`serveHostProject`).
 */
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OBSERVER_MODULE_ID,
  livePassThroughLine,
  liveProjectFor,
  pyricWithSuppliedRows,
  type PyricOptions,
  type SuppliedRowsPlane,
} from '@pyric/cli/vite/internal/supplied-rows';
import { serveHostProject, withObserverProject } from './page-modules.js';
import { canPassThrough, liveRefusal, passThroughOption, refusedImportsLine, withPassThroughHint } from './refusal.js';
import { liveStartLine, passThroughLines } from './start-line.js';
import { liveStartRefusal } from './start-checks.js';

type PyricPlugin = ReturnType<typeof pyricWithSuppliedRows>;
type ConfigResolvedHook = Extract<PyricPlugin['configResolved'], (...args: never[]) => unknown>;
type ConfigureServerHook = Extract<PyricPlugin['configureServer'], (...args: never[]) => unknown>;
type LoadHook = Extract<PyricPlugin['load'], (...args: never[]) => unknown>;
type ResolvedConfig = Parameters<ConfigResolvedHook>[0];
type DevServer = Parameters<ConfigureServerHook>[0];

/** The plugin options live mode takes: `@pyric/cli`'s, always on the Node host, and the imports that pass through. */
export type PyricLiveOptions = Omit<PyricOptions, 'hosted' | 'swapInBuild' | 'sessionToken' | 'serviceWorker'> & {
  /**
   * Firebase imports live mode does not serve, such as `firebase/functions`
   * or `firebase/remote-config`, that load the app's installed SDK unwrapped. Their
   * calls go to production unobserved and still bill. Listing an import live
   * mode serves, `firebase-admin` or an `@firebase/*` package stops the dev
   * server at start.
   */
  passThrough?: readonly string[];
};

/** Writes one line to the dev server's terminal. */
type LogLine = (line: string) => void;

/**
 * Live mode's page refusal, which for an unserved import the app could list
 * also names the `passThrough` option, and tells the dev server's terminal
 * once per new import, with every one asked for so far.
 */
function pageRefusal(log: () => LogLine | undefined): (specifier: string, plane: SuppliedRowsPlane) => Error {
  const asked = new Set<string>();
  return (specifier, plane) => {
    const error = liveRefusal(specifier, plane);
    const isPassable = plane === 'page' && canPassThrough(specifier);
    if (!isPassable) return error;
    const isNew = !asked.has(specifier);
    asked.add(specifier);
    if (isNew) log()?.(refusedImportsLine(ENTRY, [...asked]));
    return withPassThroughHint(error, specifier);
  };
}

/** The start line, then one line for each import that passes through, and the Admin line when the list names firebase-admin. */
function startLines(projectId: string, passThrough: readonly string[]): string {
  const passing = passThroughLines(ENTRY, passThrough, livePassThroughLine);
  return [liveStartLine(ENTRY, projectId), ...passing].join('\n');
}

const ENTRY = '@pyric/live/vite';

/** This package's folder: the one above `dist/` in the installed files, or above `src/` in the workspace. */
const LIVE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Whether Vite runs the dev server: live mode never applies to a build or a preview. */
function isDevServer(_config: unknown, env: { command: string; isPreview?: boolean }): boolean {
  return env.command === 'serve' && env.isPreview !== true;
}

/** Live mode for `vite dev`. */
export function pyricLive(options: PyricLiveOptions = {}): PyricPlugin {
  const {
    passThrough: listed,
    serviceWorker: _ignoredServiceWorker,
    ...pyricOptions
  } = options as PyricLiveOptions & { serviceWorker?: unknown };
  void _ignoredServiceWorker;
  const passThrough = passThroughOption(ENTRY, listed);
  let logError: LogLine | undefined;
  const refusal = pageRefusal(() => logError);
  const hosted = pyricWithSuppliedRows({ ...pyricOptions, hosted: true }, { refusal, liveRoot: LIVE_ROOT, passThrough });
  const configResolved = hosted.configResolved as ConfigResolvedHook | undefined;
  const configureServer = hosted.configureServer as ConfigureServerHook | undefined;
  const load = hosted.load as LoadHook | undefined;
  let projectId = '';
  return {
    ...hosted,
    apply: isDevServer,
    async configResolved(this: unknown, resolved: ResolvedConfig) {
      const refusal = liveStartRefusal(resolved.root);
      if (refusal !== null) throw new Error(`${ENTRY}: ${refusal}`);
      projectId = liveProjectFor(resolved.root, options);
      serveHostProject(projectId);
      logError = (line) => resolved.logger.error(line, { timestamp: true });
      await configResolved?.call(this as never, resolved);
    },
    async load(this: unknown, id: string, ...rest: unknown[]) {
      const source = await (load as ((this: unknown, id: string, ...args: unknown[]) => unknown) | undefined)?.call(
        this,
        id,
        ...rest,
      );
      if (id === OBSERVER_MODULE_ID && typeof source === 'string' && projectId !== '') {
        return withObserverProject(source, projectId);
      }
      return source;
    },
    async configureServer(this: unknown, server: DevServer) {
      await configureServer?.call(this as never, server);
      server.config.logger.info(startLines(projectId, passThrough));
    },
  } as PyricPlugin;
}
