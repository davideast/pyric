// The host's git never runs what a session plants in the roles' clone: an
// fsmonitor, hooks, an upload-pack hook, a textconv or an external diff, in
// the clone's config or its hooks directory. Each planted program writes a
// marker file; the fetch, the archive, the show and the diff must leave none.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedLines } from './diff-lines.ts';
import { archiveCommit, fetchHead, initBareRepo, showFile, sourceProblem } from './git.ts';

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
