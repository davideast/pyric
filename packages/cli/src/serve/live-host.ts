/**
 * `@pyric/cli/serve/internal/live-host`: the one seam through which the
 * `pyric-live` command starts the Node host. It is `pyric sandbox --hosted`
 * itself (`runServe`), with two differences: the host reports its project
 * as live, so the chip and Studio show "Live: <project-id>", and the pages
 * it serves get no Firebase SDK (`live-host-pages.ts`).
 *
 * The gate is the `@pyric/live` installed in the project: without it this
 * refuses to start. `pyric sandbox` never reads this module, and no flag,
 * config key or environment variable reaches it.
 */
import { parseArgs } from '../cli/parse-args.js';
import { runServe } from '../cli/serve.js';
import { installedLiveFile, liveNotInstalled } from './installed-live-package.js';
import { liveProjectId } from './live-project.js';

export { LiveProjectMissingError, liveProjectId } from './live-project.js';

/** The `@pyric/live` export whose presence opens this seam: the package's own command. */
const LIVE_COMMAND_SUBPATH = 'register';

const CHILD_COMMAND_REFUSAL =
  'pyric-live starts no command after --. Start your server in another terminal with: node --import @pyric/live/register server.js';

/** The project a `pyric-live` run with `argv` names: `--project`, else the app's Firebase config. */
export function liveHostProject(argv: readonly string[], projectRoot: string): string {
  const flag = parseArgs(['sandbox', ...argv]).flags.get('project');
  return liveProjectId(projectRoot, typeof flag === 'string' ? flag : undefined);
}

/**
 * Runs the Node host for `argv` (`pyric sandbox --hosted`'s flags) in the
 * working directory, and resolves with its exit code when it stops. Throws
 * when `@pyric/live` is not installed there or no project is set.
 */
export async function runLiveHost(argv: readonly string[]): Promise<number> {
  const projectRoot = process.cwd();
  const installed = installedLiveFile(projectRoot, LIVE_COMMAND_SUBPATH);
  if (installed === null) throw liveNotInstalled(projectRoot, 'The live host did not start.');
  const parsed = parseArgs(['sandbox', ...argv]);
  const hasChildCommand = (parsed.passthrough ?? []).length > 0;
  if (hasChildCommand) throw new Error(CHILD_COMMAND_REFUSAL);
  // A child command would get the sandbox register, so the live host starts none.
  parsed.flags.set('no-run', true);
  // The host names the project every live entry resolves, so the start line and the chip agree.
  parsed.flags.set('project', liveHostProject(argv, projectRoot));
  parsed.flags.set('hosted', true);
  return runServe(parsed, { live: true });
}
