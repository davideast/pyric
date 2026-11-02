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
 * exports a commit with `git archive`; no check tree has a `.git`. The
 * fetch refuses a clone whose `.git` sends git elsewhere, and its
 * upload-pack runs in a sandbox that sees only that `.git`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemBinds } from '../namespace.ts';

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

/** Files at the top of a `.git` that make git read its objects and refs from another directory. */
const REDIRECT_FILES = ['commondir', 'gitdir'];

/** The first entry under `dir` that is a link, or neither a regular file nor a directory. */
function linkUnder(dir: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) return `${path} is a symbolic link`;
    if (entry.isDirectory()) {
      const inner = linkUnder(path);
      if (inner !== undefined) return inner;
    } else if (!entry.isFile()) return `${path} is not a regular file or directory`;
  }
  return undefined;
}

/**
 * Why the harness won't fetch from `source`: a `.git` that is not a plain
 * directory, one that sends git elsewhere (a link or special file anywhere
 * in it, `commondir`, `gitdir`), or objects borrowed from another repo.
 */
export function sourceProblem(source: string): string | undefined {
  const dotGit = join(source, '.git');
  const stat = lstatSync(dotGit, { throwIfNoEntry: false });
  if (stat === undefined || !stat.isDirectory()) return `${dotGit} is not a directory`;
  const redirect = REDIRECT_FILES.map((name) => join(dotGit, name)).find((path) => lstatSync(path, { throwIfNoEntry: false }) !== undefined);
  if (redirect !== undefined) return `${redirect} points the repo at another directory`;
  const borrowsObjects = existsSync(join(dotGit, 'objects', 'info', 'alternates'));
  if (borrowsObjects) return `${dotGit} borrows objects from another repo (objects/info/alternates)`;
  return linkUnder(dotGit);
}

/** Where the source's `.git` sits inside the upload-pack sandbox. */
const SOURCE_IN_SANDBOX = '/source.git';

const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The upload-pack the fetch starts: git upload-pack in a bwrap sandbox that
 * sees the host's /usr and the source's `.git`, read-only, and nothing else,
 * so no link or path in that `.git` can name another repository. Git runs it
 * as `<command> "$@"` with the source path; the function ignores that path
 * for the one bound here.
 */
export function uploadPackCommand(dotGit: string): string {
  const bwrap = [
    'bwrap', '--unshare-all', '--die-with-parent', '--new-session',
    ...systemBinds(),
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--ro-bind', dotGit, SOURCE_IN_SANDBOX,
    '--chdir', '/',
    'git', 'upload-pack', '--strict', SOURCE_IN_SANDBOX,
  ];
  return `sandboxed() { exec ${bwrap.map(shellQuote).join(' ')}; }; sandboxed`;
}

const HEAD_REF = 'refs/factory/head';

/** Fetches `source`'s HEAD into the harness's repo through the sandboxed upload-pack, with no check of the source first. */
export function fetchSandboxed(gitDir: string, source: string): string {
  const uploadPack = uploadPackCommand(join(source, '.git'));
  bareGit(gitDir, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--force', `--upload-pack=${uploadPack}`, source, `+HEAD:${HEAD_REF}`]);
  return bareGit(gitDir, ['rev-parse', '--verify', `${HEAD_REF}^{commit}`]).trim();
}

/** Fetches `source`'s HEAD into the harness's repo and returns its commit. */
export function fetchHead(gitDir: string, source: string): string {
  const problem = sourceProblem(source);
  if (problem !== undefined) throw new GitError(`refusing to fetch from ${source}: ${problem}`);
  return fetchSandboxed(gitDir, source);
}

/** Writes `commit`'s tree as a tar file, with no `.git`. */
export function archiveCommit(gitDir: string, commit: string, tarFile: string): void {
  bareGit(gitDir, ['archive', '--format=tar', '-o', tarFile, commit]);
}

/** A file's text at `commit`, from the objects only. */
export function showFile(gitDir: string, commit: string, path: string): string {
  return bareGit(gitDir, ['show', `${commit}:${path}`]);
}
