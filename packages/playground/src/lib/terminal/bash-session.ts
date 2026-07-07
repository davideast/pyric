/**
 * Bash session factory. Builds a {@link Bash} instance whose
 * filesystem is the OPFS VFS, optionally narrowed to a subtree via
 * `repoDir`. The browser bundle of `just-bash` ships core shell
 * primitives only — no Python, no `js-exec` — which is all we need
 * for a terminal that drives the cloned repo.
 *
 * Each `Bash.exec(line)` resets the environment between calls. The
 * session is therefore stateless across executions; callers that need
 * a persistent `cwd` should keep one themselves and prepend
 * `cd <cwd> && ` to each command (see TerminalPanel).
 */

import { Bash, InMemoryFs, MountableFs } from 'just-bash';

import { getVFS } from '~/lib/vfs';

import { OPFSBashFs } from './opfs-bash-fs';

/**
 * Bash sees `/workspace` as the cwd; the OPFSBashFs underneath
 * translates that to the OPFS path `/workspace`, so the user-visible
 * file tree is exactly the playground workspace and nothing else
 * (no sibling `packages/` directory, no stale OPFS artefacts).
 */
const MOUNT_POINT = '/workspace';
const OPFS_PREFIX = '/workspace';

export interface BashExecOptions {
  /** Cooperative cancellation — abort the in-flight command at the
   *  next statement boundary. just-bash honors this natively. */
  signal?: AbortSignal;
}

export interface BashSession {
  /** The underlying just-bash environment. */
  bash: Bash;
  /** Run a single command line and return normalised output. */
  exec(
    line: string,
    options?: BashExecOptions,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export function createBashSession(repoDir = OPFS_PREFIX): BashSession {
  const opfsFs = new OPFSBashFs(getVFS(), repoDir);
  const fs = new MountableFs({
    base: new InMemoryFs(),
    mounts: [{ mountPoint: MOUNT_POINT, filesystem: opfsFs }],
  });
  const bash = new Bash({ fs, cwd: MOUNT_POINT });
  return {
    bash,
    async exec(line, options) {
      const result = await bash.exec(line, options?.signal ? { signal: options.signal } : undefined);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
  };
}
