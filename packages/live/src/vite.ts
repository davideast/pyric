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
 * so nothing in `pyric` or `@pyric/cli` opens the rows without it. The dev
 * server is the Node host: a Node process under `@pyric/live/register`
 * finds it through the project's `.pyric/serve.json`, as it finds the host
 * `pyric-live` starts.
 *
 * The dev server refuses to start when a start check fails
 * (`start-checks.ts`) or no project is set, and prints the start line once
 * it serves.
 */
import { liveProjectFor, pyricWithSuppliedRows, type PyricOptions } from '@pyric/cli/vite/internal/supplied-rows';
import { liveRefusal } from './refusal.js';
import { liveStartLine } from './start-line.js';
import { liveStartRefusal } from './start-checks.js';

type PyricPlugin = ReturnType<typeof pyricWithSuppliedRows>;
type ConfigResolvedHook = Extract<PyricPlugin['configResolved'], (...args: never[]) => unknown>;
type ConfigureServerHook = Extract<PyricPlugin['configureServer'], (...args: never[]) => unknown>;
type ResolvedConfig = Parameters<ConfigResolvedHook>[0];
type DevServer = Parameters<ConfigureServerHook>[0];

/** The plugin options live mode takes: `@pyric/cli`'s, always on the Node host. */
export type PyricLiveOptions = Omit<PyricOptions, 'hosted' | 'swapInBuild'>;

const ENTRY = '@pyric/live/vite';

/** Whether Vite runs the dev server: live mode never applies to a build or a preview. */
function isDevServer(_config: unknown, env: { command: string; isPreview?: boolean }): boolean {
  return env.command === 'serve' && env.isPreview !== true;
}

/** Live mode for `vite dev`. */
export function pyricLive(options: PyricLiveOptions = {}): PyricPlugin {
  const hosted = pyricWithSuppliedRows({ ...options, hosted: true }, { refusal: liveRefusal });
  const configResolved = hosted.configResolved as ConfigResolvedHook | undefined;
  const configureServer = hosted.configureServer as ConfigureServerHook | undefined;
  let projectId = '';
  return {
    ...hosted,
    apply: isDevServer,
    async configResolved(this: unknown, resolved: ResolvedConfig) {
      const refusal = liveStartRefusal(resolved.root);
      if (refusal !== null) throw new Error(`${ENTRY}: ${refusal}`);
      projectId = liveProjectFor(resolved.root, options);
      await configResolved?.call(this as never, resolved);
    },
    async configureServer(this: unknown, server: DevServer) {
      await configureServer?.call(this as never, server);
      server.config.logger.info(liveStartLine(ENTRY, projectId));
    },
  } as PyricPlugin;
}
