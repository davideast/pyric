/**
 * The git commands the factory runs on the host, every one hardened so no
 * config, hook or attribute from a repo a session can write runs anything:
 *
 * - No system or global config (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`).
 * - The settings that run a program forced off on the command line, which
 *   git also hands to the upload-pack it starts in a source repo during a
 *   fetch: fsmonitor, hooks, textconv and external diffs, attribute files,
 *   ssh and proxy commands.
 *
 * During a run the host runs git only in the harness's own bare repo,
 * `<run>.host/git`. It fetches the roles' commits from their clone, which
 * reads objects and refs there and nothing of its working tree, and
 * exports a commit with `git archive`; no check tree has a `.git`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class GitError extends Error {}

const IDENTITY = ['-c', 'user.name=pyric factory', '-c', 'user.email=factory@pyric.invalid'];

/** Settings forced on every call; `-c` reaches the upload-pack a fetch starts too. */
export const SAFE_CONFIG: readonly string[] = [
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'core.untrackedCache=false',
  'core.attributesFile=/dev/null',
  'core.sshCommand=false',
  'core.gitProxy=',
  'core.askPass=',
  'diff.external=',
  'uploadpack.packObjectsHook=',
  'uploadpack.allowFilter=false',
  'protocol.allow=never',
  'protocol.file.allow=always',
].flatMap((setting) => ['-c', setting]);

export function safeGitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH ?? '',
    LANG: env.LANG ?? 'C.UTF-8',
    HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
  };
}

function run(args: readonly string[], cwd: string): string {
  const result = spawnSync('git', [...SAFE_CONFIG, ...IDENTITY, ...args], { cwd, env: safeGitEnvironment(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new GitError(`git ${args.join(' ')} in ${cwd} failed:\n${result.stderr}`);
  return result.stdout;
}

/** Git in a working tree. Setup uses it on the roles' clone before any session exists. */
export function git(cwd: string, args: readonly string[]): string {
  return run(args, cwd);
}

export function headCommit(cwd: string): string {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

/** Clones `source` into `dir` with no remote left behind, so nothing can push back to it. */
export function cloneWithoutRemote(source: string, dir: string): void {
  git(source, ['clone', '--quiet', '--no-hardlinks', source, dir]);
  git(dir, ['remote', 'remove', 'origin']);
}

/** Git in the harness's bare repo. */
export function bareGit(gitDir: string, args: readonly string[]): string {
  return run(['--git-dir', gitDir, ...args], '/');
}

export function initBareRepo(gitDir: string): void {
  if (existsSync(join(gitDir, 'HEAD'))) return;
  mkdirSync(gitDir, { recursive: true, mode: 0o700 });
  bareGit(gitDir, ['init', '--quiet', '--bare']);
}

/** Why the harness won't fetch from `source`: a `.git` that is a link or file, or objects borrowed from another repo. */
export function sourceProblem(source: string): string | undefined {
  const dotGit = join(source, '.git');
  const stat = lstatSync(dotGit, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) return `${dotGit} is not a directory`;
  const borrowsObjects = existsSync(join(dotGit, 'objects', 'info', 'alternates'));
  if (borrowsObjects) return `${dotGit} borrows objects from another repo (objects/info/alternates)`;
  return undefined;
}

const HEAD_REF = 'refs/factory/head';

/** Fetches `source`'s HEAD into the harness's repo and returns its commit. */
export function fetchHead(gitDir: string, source: string): string {
  const problem = sourceProblem(source);
  if (problem !== undefined) throw new GitError(`refusing to fetch from ${source}: ${problem}`);
  bareGit(gitDir, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--force', source, `+HEAD:${HEAD_REF}`]);
  return bareGit(gitDir, ['rev-parse', '--verify', `${HEAD_REF}^{commit}`]).trim();
}

/** Writes `commit`'s tree as a tar file, with no `.git`. */
export function archiveCommit(gitDir: string, commit: string, tarFile: string): void {
  bareGit(gitDir, ['archive', '--format=tar', '-o', tarFile, commit]);
}

/** A file's text at `commit`, from the objects only. */
export function showFile(gitDir: string, commit: string, path: string): string {
  return bareGit(gitDir, ['show', `${commit}:${path}`]);
}
