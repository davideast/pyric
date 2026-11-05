/**
 * `@pyric/cli/serve/internal/live-host`: the one seam through which the
 * `pyric-live` command starts the Node host. It is `pyric sandbox --hosted`
 * itself (`runServe`), with three differences: the host reports its status
 * as live, so the chip and Studio show "Live: <project-id>"; the pages it
 * serves get no Firebase SDK (`live-host-pages.ts`); and it refuses every
 * one of pyric's own writes, as the Vite live host does
 * (`hosted/own-writes.ts`).
 *
 * The host runs in the Firebase project root: the nearest folder from the
 * working directory up that holds `.firebaserc` or `firebase.json`
 * (`findFirebaseProjectDir`, as the Vite plugin and the live register find
 * it), or the working directory when none does.
 *
 * The gate is an installed `@pyric/live`: the one whose command is running,
 * when the package resolves there, or else the one the project root
 * resolves, as the register finds it (`liveResolutionRoot`). Without it this
 * refuses to start. `pyric sandbox` never reads this module, and no flag,
 * config key or environment variable reaches it.
 */
import { parseArgs } from '../cli/parse-args.js';
import { runServe } from '../cli/serve.js';
import { installedLiveFile, liveNotInstalled, loadInstalledLiveExport } from './installed-live-package.js';
import type { PyricWriteRefusal } from './hosted/own-writes.js';
import { findFirebaseProjectDir, resolveFirebaseProject, type FirebaseProjectResolution } from '../cli/firebase-project.js';
import { liveResolutionRoot } from '../register/live-package.js';
import { requireLiveProject } from './live-project.js';

export { LiveProjectMissingError, liveProjectId } from './live-project.js';

/** The `@pyric/live` export whose presence opens this seam: the package's own command. */
const LIVE_COMMAND_SUBPATH = 'register';
/** The built `@pyric/live` export that gives this host its refusal of pyric's own writes. */
const WRITE_REFUSAL_SUBPATH = 'node-modules';

const CHILD_COMMAND_REFUSAL =
  'pyric-live starts no command after --. Start your server in another terminal with: node --import @pyric/live/register server.js';

function liveHostResolution(argv: readonly string[], projectRoot: string): FirebaseProjectResolution {
  const flag = parseArgs(['sandbox', ...argv]).flags.get('project');
  return resolveFirebaseProject({ projectDir: projectRoot, option: typeof flag === 'string' ? flag : undefined });
}

/** The Firebase project root for a `pyric-live` run started in `cwd`, or `cwd` when there is none. */
export function liveHostProjectRoot(cwd: string): string {
  return findFirebaseProjectDir(cwd) ?? cwd;
}

/** The project a `pyric-live` run with `argv` names: `--project`, else the app's Firebase config. */
export function liveHostProject(argv: readonly string[], projectRoot: string): string {
  return requireLiveProject(liveHostResolution(argv, projectRoot), projectRoot);
}

export interface LiveHostStart {
  /** The folder of the `@pyric/live` whose `pyric-live` command is running. */
  liveRoot?: string;
}

/**
 * Runs the Node host for `argv` (`pyric sandbox --hosted`'s flags) in the
 * project root found from the working directory, and resolves with its exit
 * code when it stops. Throws when `@pyric/live` is not installed there or no
 * project is set.
 */
export async function runLiveHost(argv: readonly string[], start: LiveHostStart = {}): Promise<number> {
  const projectRoot = liveHostProjectRoot(process.cwd());
  const from = liveResolutionRoot(projectRoot, start.liveRoot);
  const installed = installedLiveFile(from, LIVE_COMMAND_SUBPATH);
  if (installed === null) throw liveNotInstalled(projectRoot, 'The live host did not start.');
  // `runServe` reads its project from the working directory: firebase.json, pyric.json, rules and Hosting files.
  process.chdir(projectRoot);
  const parsed = parseArgs(['sandbox', ...argv]);
  const hasChildCommand = (parsed.passthrough ?? []).length > 0;
  if (hasChildCommand) throw new Error(CHILD_COMMAND_REFUSAL);
  // A child command would get the sandbox register, so the live host starts none.
  parsed.flags.set('no-run', true);
  // The host names the project every live entry resolves, so the start line and the chip agree.
  const project = liveHostResolution(argv, projectRoot);
  parsed.flags.set('project', requireLiveProject(project, projectRoot));
  parsed.flags.set('hosted', true);
  const refusal = await loadInstalledLiveExport(from, WRITE_REFUSAL_SUBPATH, 'liveWriteRefusal', 'The live host did not start.');
  return runServe(parsed, { liveHost: { project, writeRefusal: refusal.fn as unknown as PyricWriteRefusal } });
}
