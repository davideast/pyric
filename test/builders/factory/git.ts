/** The few git commands the factory runs on the app's checkouts, on the host. */
import { spawnSync } from 'node:child_process';

export class GitError extends Error {}

/** The factory's own commits: a fixed identity, and no hooks of the app's. */
const IDENTITY = ['-c', 'user.name=pyric factory', '-c', 'user.email=factory@pyric.invalid', '-c', 'core.hooksPath=/dev/null'];

export function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new GitError(`git ${args.join(' ')} in ${cwd} failed:\n${result.stderr}`);
  return result.stdout;
}

export function headCommit(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

/** Points `dir`, a clone of `source`, at `commit`, detached, discarding local changes to tracked files. */
export function checkoutCommit(dir: string, source: string, commit: string): void {
  // The source's HEAD and branches, whatever the roles named them, then the commit among them.
  git(dir, ['fetch', '--quiet', '--force', source, '+HEAD:refs/factory/source-head', '+refs/heads/*:refs/factory/heads/*']);
  git(dir, ['checkout', '--quiet', '--force', '--detach', commit]);
}

/** Clones `source` into `dir` with no remote left behind, so nothing can push back to it. */
export function cloneWithoutRemote(source: string, dir: string): void {
  git(source, ['clone', '--quiet', '--no-hardlinks', source, dir]);
  git(dir, ['remote', 'remove', 'origin']);
}
