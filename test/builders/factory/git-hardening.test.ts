// The host's git never runs what a session plants in the roles' clone: an
// fsmonitor, hooks, an upload-pack hook, a textconv or an external diff, in
// the clone's config or its hooks directory. Each planted program writes a
// marker file; the fetch, the archive, the show and the diff must leave none.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedLines } from './diff-lines.ts';
import { archiveCommit, fetchHead, fetchSandboxed, GitError, initBareRepo, showFile, sourceProblem } from './git.ts';

function sh(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

/** A script that records its own name in `markers` whenever it runs. */
function plant(dir: string, name: string, markers: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ntouch ${JSON.stringify(join(markers, name))}\ncat >/dev/null 2>&1 || true\n`);
  chmodSync(path, 0o755);
  return path;
}

const HOOKS = ['pre-commit', 'post-checkout', 'post-merge', 'reference-transaction', 'pre-push', 'post-index-change', 'pre-auto-gc', 'post-rewrite'];

function sessionClone(): { source: string; markers: string; first: string; second: string } {
  const base = mkdtempSync(join(tmpdir(), 'factory-git-'));
  const source = join(base, 'app');
  const markers = join(base, 'markers');
  const scripts = join(base, 'scripts');
  for (const dir of [source, markers, scripts]) mkdirSync(dir, { recursive: true });
  sh(source, 'git', ['init', '--quiet']);
  sh(source, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '--allow-empty', '-m', 'start']);
  const first = sh(source, 'git', ['rev-parse', 'HEAD']).trim();
  writeFileSync(join(source, 'page.tsx'), 'export const a = 1;\n');
  writeFileSync(join(source, '.gitattributes'), '*.tsx diff=evil filter=evil\n');
  sh(source, 'git', ['add', '.']);
  sh(source, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'change']);
  const second = sh(source, 'git', ['rev-parse', 'HEAD']).trim();
  // What a session can write: the clone's config and its hooks.
  const hooks = join(source, '.git', 'hooks');
  for (const hook of HOOKS) plant(hooks, hook, markers);
  const config = [
    ['core.fsmonitor', plant(scripts, 'fsmonitor', markers)],
    ['core.hooksPath', hooks],
    ['uploadpack.packObjectsHook', plant(scripts, 'pack-objects-hook', markers)],
    ['diff.external', plant(scripts, 'external-diff', markers)],
    ['diff.evil.textconv', plant(scripts, 'textconv', markers)],
    ['filter.evil.smudge', plant(scripts, 'smudge', markers)],
    ['filter.evil.clean', plant(scripts, 'clean', markers)],
    ['core.sshCommand', plant(scripts, 'ssh', markers)],
  ];
  for (const [key, value] of config) sh(source, 'git', ['config', key as string, value as string]);
  return { source, markers, first, second };
}

describe('the host\'s git and a session\'s planted config', () => {
  test('the plant works: plain git in the clone runs the fsmonitor', () => {
    const clone = sessionClone();
    sh(clone.source, 'git', ['status', '--short']);
    expect(existsSync(join(clone.markers, 'fsmonitor'))).toBe(true);
  });

  test('fetch, archive, show and diff in the harness\'s repo run none of it', () => {
    const clone = sessionClone();
    const gitDir = join(mkdtempSync(join(tmpdir(), 'factory-bare-')), 'git');
    initBareRepo(gitDir);
    const head = fetchHead(gitDir, clone.source);
    expect(head).toBe(clone.second);
    const tar = join(mkdtempSync(join(tmpdir(), 'factory-tar-')), 'tree.tar');
    archiveCommit(gitDir, head, tar);
    expect(existsSync(tar)).toBe(true);
    expect(showFile(gitDir, head, 'page.tsx')).toBe('export const a = 1;\n');
    expect([...changedLines(gitDir, clone.first, head, '.').keys()]).toContain('page.tsx');
    expect(readdirSync(clone.markers)).toEqual([]);
  });

  test('a clone that borrows objects or whose .git is a link is refused', () => {
    const clone = sessionClone();
    mkdirSync(join(clone.source, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(join(clone.source, '.git', 'objects', 'info', 'alternates'), '/elsewhere/objects\n');
    expect(sourceProblem(clone.source)).toContain('alternates');
  });
});

/** A repo the host user can read and no session should reach, with a file only it has. */
function otherRepo(): { dotGit: string; head: string } {
  const dir = join(mkdtempSync(join(tmpdir(), 'factory-other-')), 'other');
  mkdirSync(dir);
  sh(dir, 'git', ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(dir, 'secret.txt'), 'only the other repo has this\n');
  sh(dir, 'git', ['add', '.']);
  sh(dir, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'other']);
  return { dotGit: join(dir, '.git'), head: sh(dir, 'git', ['rev-parse', 'HEAD']).trim() };
}

/** A clone whose HEAD is `main`, ready for a redirect. */
function plainClone(): string {
  const source = join(mkdtempSync(join(tmpdir(), 'factory-clone-')), 'app');
  mkdirSync(source);
  sh(source, 'git', ['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(source, 'page.tsx'), 'export const a = 1;\n');
  sh(source, 'git', ['add', '.']);
  sh(source, 'git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'mine']);
  return source;
}

/** What a session can do inside its own `.git` to point git at the other repo. */
const REDIRECTS: Record<string, { offending: string; apply: (dotGit: string, other: { dotGit: string; head: string }) => void }> = {
  'objects linked to the other repo\'s': {
    offending: 'objects is a symbolic link',
    apply: (dotGit, other) => {
      renameSync(join(dotGit, 'objects'), join(dotGit, 'objects-mine'));
      symlinkSync(join(other.dotGit, 'objects'), join(dotGit, 'objects'));
      writeFileSync(join(dotGit, 'refs', 'heads', 'main'), `${other.head}\n`);
    },
  },
  'a ref linked to the other repo\'s': {
    offending: 'main is a symbolic link',
    apply: (dotGit, other) => {
      // The other repo's objects are copied in first, so the ref alone is what redirects; a session couldn't copy them, which only makes the ref variant weaker.
      sh(dotGit, 'git', ['--git-dir', dotGit, 'fetch', '--quiet', other.dotGit, 'main:refs/borrowed']);
      sh(dotGit, 'git', ['--git-dir', dotGit, 'update-ref', '-d', 'refs/borrowed']);
      renameSync(join(dotGit, 'refs', 'heads', 'main'), join(dotGit, 'main-mine'));
      symlinkSync(join(other.dotGit, 'refs', 'heads', 'main'), join(dotGit, 'refs', 'heads', 'main'));
    },
  },
  '.git itself linked to the other repo\'s': {
    offending: '.git is not a directory',
    apply: (dotGit, other) => {
      renameSync(dotGit, `${dotGit}-mine`);
      symlinkSync(other.dotGit, dotGit);
    },
  },
  'commondir naming the other repo': {
    offending: 'commondir points the repo at another directory',
    apply: (dotGit, other) => writeFileSync(join(dotGit, 'commondir'), `${other.dotGit}\n`),
  },
};

function secretIn(gitDir: string, commit: string): boolean {
  try {
    return showFile(gitDir, commit, 'secret.txt').length > 0;
  } catch {
    return false;
  }
}

describe('a clone whose .git sends git to another repository', () => {
  for (const [name, redirect] of Object.entries(REDIRECTS)) {
    describe(name, () => {
      const other = otherRepo();
      const source = plainClone();
      const dotGit = join(source, '.git');
      redirect.apply(dotGit, other);

      test('the plant works: an unsandboxed fetch gets the other repo\'s commit', () => {
        const gitDir = join(mkdtempSync(join(tmpdir(), 'factory-bare-')), 'git');
        initBareRepo(gitDir);
        sh('/', 'git', ['--git-dir', gitDir, 'fetch', '--quiet', source, '+HEAD:refs/plain']);
        const fetched = sh('/', 'git', ['--git-dir', gitDir, 'rev-parse', 'refs/plain']).trim();
        expect(fetched).toBe(other.head);
        expect(secretIn(gitDir, fetched)).toBe(true);
      });

      test('the fetch refuses it and names the path', () => {
        const gitDir = join(mkdtempSync(join(tmpdir(), 'factory-bare-')), 'git');
        initBareRepo(gitDir);
        expect(sourceProblem(source)).toContain(redirect.offending);
        expect(() => fetchHead(gitDir, source)).toThrow(redirect.offending);
      });

      test('the sandboxed upload-pack, unchecked, never brings the other repo\'s tree into a check tree', () => {
        const gitDir = join(mkdtempSync(join(tmpdir(), 'factory-bare-')), 'git');
        initBareRepo(gitDir);
        let fetched: string | undefined;
        try {
          fetched = fetchSandboxed(gitDir, source);
        } catch (error) {
          expect(error).toBeInstanceOf(GitError);
        }
        if (fetched === undefined) return;
        expect(fetched).not.toBe(other.head);
        expect(secretIn(gitDir, fetched)).toBe(false);
        const tar = join(mkdtempSync(join(tmpdir(), 'factory-tar-')), 'tree.tar');
        archiveCommit(gitDir, fetched, tar);
        expect(sh('/', 'tar', ['-tf', tar])).not.toContain('secret.txt');
      });
    });
  }

  const swaps: Record<string, (dotGit: string, other: { dotGit: string }) => void> = {
    'a link to the other repo': (dotGit, other) => symlinkSync(other.dotGit, dotGit),
    'a copy of the other repo': (dotGit, other) => cpSync(other.dotGit, dotGit, { recursive: true }),
  };
  for (const [name, swapIn] of Object.entries(swaps)) {
    test(`a .git swapped for ${name} after the check is never the one fetched`, () => {
      const other = otherRepo();
      const source = plainClone();
      const mine = sh(source, 'git', ['rev-parse', 'HEAD']).trim();
      const dotGit = join(source, '.git');
      const gitDir = join(mkdtempSync(join(tmpdir(), 'factory-bare-')), 'git');
      initBareRepo(gitDir);
      const swap = () => {
        renameSync(dotGit, join(source, 'checked.git'));
        swapIn(dotGit, other);
      };
      const fetched = fetchHead(gitDir, source, swap);
      expect(sh(source, 'git', ['--git-dir', dotGit, 'rev-parse', 'HEAD']).trim()).toBe(other.head);
      expect(fetched).toBe(mine);
      expect(secretIn(gitDir, fetched)).toBe(false);
    });
  }

  test('an ordinary clone still fetches through the sandboxed upload-pack', () => {
    const source = plainClone();
    const gitDir = join(mkdtempSync(join(tmpdir(), 'factory-bare-')), 'git');
    initBareRepo(gitDir);
    expect(sourceProblem(source)).toBeUndefined();
    expect(fetchHead(gitDir, source)).toBe(sh(source, 'git', ['rev-parse', 'HEAD']).trim());
  });
});
