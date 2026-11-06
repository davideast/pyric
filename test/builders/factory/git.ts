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
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync } from 'node:fs';
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

/** Runs git; `passFd`, when given, becomes the child's fd 3, which its children inherit. */
function run(args: readonly string[], cwd: string, passFd?: number): string {
  const stdio: Array<'pipe' | number> = ['pipe', 'pipe', 'pipe'];
  if (passFd !== undefined) stdio.push(passFd);
  const result = spawnSync('git', [...SAFE_CONFIG, ...IDENTITY, ...args], { cwd, env: safeGitEnvironment(), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio });
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

/** The first entry under `dir` that is a link, or neither a regular file nor a directory; named under `shown`. */
function linkUnder(dir: string, shown: string): string | undefined {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(shown, entry.name);
    if (entry.isSymbolicLink()) return `${path} is a symbolic link`;
    if (entry.isDirectory()) {
      const inner = linkUnder(join(dir, entry.name), path);
      if (inner !== undefined) return inner;
    } else if (!entry.isFile()) return `${path} is not a regular file or directory`;
  }
  return undefined;
}

/**
 * The source's `.git`, opened once with O_DIRECTORY and O_NOFOLLOW. The
 * check reads that directory through the descriptor and the sandbox binds
 * the same descriptor, so a `.git` swapped after the check is never the one
 * mounted. Undefined when `.git` is not a plain directory.
 */
export function openSource(source: string): number | undefined {
  try {
    return openSync(join(source, '.git'), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
}

/** The opened directory, read through /proc so it is the descriptor's directory and not the path's. */
const descriptorPath = (fd: number): string => `/proc/self/fd/${fd}`;

/**
 * Why the harness won't fetch from the `.git` open at `fd`: one that sends
 * git elsewhere (a link or special file anywhere in it, `commondir`,
 * `gitdir`), or objects borrowed from another repo. `dotGit` names it.
 */
function descriptorProblem(fd: number, dotGit: string): string | undefined {
  const dir = descriptorPath(fd);
  const redirect = REDIRECT_FILES.find((name) => lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined);
  if (redirect !== undefined) return `${join(dotGit, redirect)} points the repo at another directory`;
  const borrowsObjects = existsSync(join(dir, 'objects', 'info', 'alternates'));
  if (borrowsObjects) return `${dotGit} borrows objects from another repo (objects/info/alternates)`;
  return linkUnder(dir, dotGit);
}

/** Why the harness won't fetch from `source`: a `.git` that is not a plain directory, or one `descriptorProblem` refuses. */
export function sourceProblem(source: string): string | undefined {
  const dotGit = join(source, '.git');
  const fd = openSource(source);
  if (fd === undefined) return `${dotGit} is not a directory`;
  try {
    return descriptorProblem(fd, dotGit);
  } finally {
    closeSync(fd);
  }
}

/** Where the source's `.git` sits inside the upload-pack sandbox. */
const SOURCE_IN_SANDBOX = '/source.git';

const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The upload-pack the fetch starts: git upload-pack in a bwrap sandbox that
 * sees the host's /usr and the source's `.git`, read-only, and nothing else,
 * so no link or path in that `.git` can name another repository. The `.git`
 * is the directory open at fd 3, bound with `--ro-bind-fd` (bwrap 0.9.0), not
 * looked up again by path. Git runs the command as `<command> "$@"` with the
 * source path; the function ignores that path.
 */
export function uploadPackCommand(): string {
  const bwrap = [
    'bwrap', '--unshare-all', '--die-with-parent', '--new-session',
    ...systemBinds(),
    '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
    '--ro-bind-fd', String(SOURCE_FD), SOURCE_IN_SANDBOX,
    '--chdir', '/',
    'git', 'upload-pack', '--strict', SOURCE_IN_SANDBOX,
  ];
  return `sandboxed() { exec ${bwrap.map(shellQuote).join(' ')}; }; sandboxed`;
}

/** The fd the source's `.git` has in git and in the upload-pack command it starts. */
const SOURCE_FD = 3;

const HEAD_REF = 'refs/factory/head';

/** Fetches HEAD from the `.git` open at `fd` into the harness's repo, through the sandboxed upload-pack. */
function fetchFrom(gitDir: string, source: string, fd: number): string {
  const args = ['--git-dir', gitDir, 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--force', `--upload-pack=${uploadPackCommand()}`, source, `+HEAD:${HEAD_REF}`];
  run(args, '/', fd);
  return bareGit(gitDir, ['rev-parse', '--verify', `${HEAD_REF}^{commit}`]).trim();
}

function openOrRefuse(source: string): number {
  const fd = openSource(source);
  if (fd === undefined) throw new GitError(`refusing to fetch from ${source}: ${join(source, '.git')} is not a directory`);
  return fd;
}

/** Fetches `source`'s HEAD through the sandboxed upload-pack with no check of the source first; for the tests. */
export function fetchSandboxed(gitDir: string, source: string): string {
  const fd = openOrRefuse(source);
  try {
    return fetchFrom(gitDir, source, fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Fetches `source`'s HEAD into the harness's repo and returns its commit.
 * `beforeFetch` runs between the check and the fetch; the tests swap `.git` there.
 */
export function fetchHead(gitDir: string, source: string, beforeFetch: () => void = () => {}): string {
  const fd = openOrRefuse(source);
  try {
    const problem = descriptorProblem(fd, join(source, '.git'));
    if (problem !== undefined) throw new GitError(`refusing to fetch from ${source}: ${problem}`);
    beforeFetch();
    return fetchFrom(gitDir, source, fd);
  } finally {
    closeSync(fd);
  }
}

/** Writes `commit`'s tree as a tar file, with no `.git`. */
export function archiveCommit(gitDir: string, commit: string, tarFile: string): void {
  bareGit(gitDir, ['archive', '--format=tar', '-o', tarFile, commit]);
}

/** A file's text at `commit`, from the objects only. */
export function showFile(gitDir: string, commit: string, path: string): string {
  return bareGit(gitDir, ['show', `${commit}:${path}`]);
}
