/**
 * Walker + ignore-glob tests. Semantics are pinned against
 * firebase-tools' walker — `glob.sync('**\/*', { dot: true, ignore,
 * nodir: true, posix: true })` (clones/firebase-tools/src/
 * listFiles.ts:3-11) with the scaffold defaults from
 * clones/firebase-tools/src/init/features/hosting/index.ts:20
 * (`DEFAULT_IGNORES = ["firebase.json", "**\/.*", "**\/node_modules/**"]`)
 * — including the upstream quirk that `**\/.*` does NOT exclude files
 * INSIDE dot-directories (`.git/config` uploads; verified empirically
 * against glob@10, the version firebase-tools pins).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BASE_IGNORE_GLOBS,
  DEFAULT_IGNORE_GLOBS,
  compileIgnoreGlobs,
  walkDir,
} from '../../../src/deploy/hosting/walk.js';

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-walk-'));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(dir, 'sub'));
  const files: Record<string, string> = {
    'index.html': '<html/>',
    'firebase.json': '{}',
    '.hidden': 'dot',
    'firebase-debug.log': 'log',
    '.git/config': 'git',
    'sub/.env': 'secret',
    'sub/app.js': 'js',
    'node_modules/pkg/index.js': 'dep',
  };
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

function walkedPaths(dir: string, ignore?: string[]): string[] {
  return walkDir(dir, ignore).map((f) => f.path).sort();
}

describe('walkDir — ignore globs', () => {
  test('default ignores mirror the firebase-tools scaffold (DEFAULT_IGNORES + hard-coded debug logs)', () => {
    const dir = makeFixture();
    fixtures.push(dir);
    // glob@10 parity: `.git/config` SURVIVES `**/.*` (the final path
    // segment isn't a dotfile) — same files firebase-tools uploads.
    expect(walkedPaths(dir)).toEqual(['/.git/config', '/index.html', '/sub/app.js']);
  });

  test('explicit ignore REPLACES the defaults (mirror: firebase.json ignore is the whole list)', () => {
    const dir = makeFixture();
    fixtures.push(dir);
    // Only the hard-coded debug-log globs remain (listFiles.ts:8).
    expect(walkedPaths(dir, [])).toEqual([
      '/.git/config',
      '/.hidden',
      '/firebase.json',
      '/index.html',
      '/node_modules/pkg/index.js',
      '/sub/.env',
      '/sub/app.js',
    ]);
  });

  test('custom globs: *, ?, and {a,b} alternation', () => {
    const dir = makeFixture();
    fixtures.push(dir);
    expect(walkedPaths(dir, ['**/*.{js,env}', 'firebase.json', '.hidde?', '**/.*', '.git/**'])).toEqual([
      '/index.html',
    ]);
  });

  test('directory-subtree globs prune the walk (childrenIgnored parity)', () => {
    const dir = makeFixture();
    fixtures.push(dir);
    expect(walkedPaths(dir, ['node_modules/**', 'sub/**', '**/.*', 'firebase.json'])).toEqual([
      '/.git/config',
      '/index.html',
    ]);
  });

  test('exported defaults match the firebase-tools lists verbatim', () => {
    expect(DEFAULT_IGNORE_GLOBS).toEqual(['firebase.json', '**/.*', '**/node_modules/**']);
    expect(BASE_IGNORE_GLOBS).toEqual([
      '**/firebase-debug.log',
      '**/firebase-debug.*.log',
      '.firebase/*',
    ]);
  });
});

describe('compileIgnoreGlobs — matcher semantics', () => {
  const m = (patterns: string[]) => compileIgnoreGlobs(patterns);

  test('** matches zero or more whole segments', () => {
    const matcher = m(['**/node_modules/**']);
    expect(matcher.ignoresFile('node_modules/a.js')).toBe(true);
    expect(matcher.ignoresFile('deep/node_modules/a.js')).toBe(true);
    expect(matcher.ignoresFile('node_modules_b/a.js')).toBe(false);
  });

  test('**/.* matches dotfiles at any depth but not files inside dot-directories (glob@10 parity)', () => {
    const matcher = m(['**/.*']);
    expect(matcher.ignoresFile('.env')).toBe(true);
    expect(matcher.ignoresFile('sub/.env')).toBe(true);
    expect(matcher.ignoresFile('.git/config')).toBe(false);
  });

  test('* and ? stay within one segment; dotfiles included (ignore is always dot-mode)', () => {
    const matcher = m(['*.log', 'file.?s']);
    expect(matcher.ignoresFile('.debug.log')).toBe(true);
    expect(matcher.ignoresFile('sub/app.log')).toBe(false);
    expect(matcher.ignoresFile('file.ts')).toBe(true);
    expect(matcher.ignoresFile('file.tsx')).toBe(false);
  });

  test('{a,b} expands, including nested alternation', () => {
    const matcher = m(['**/*.{js,c{ss,sv}}']);
    expect(matcher.ignoresFile('a/b.js')).toBe(true);
    expect(matcher.ignoresFile('a/b.css')).toBe(true);
    expect(matcher.ignoresFile('a/b.csv')).toBe(true);
    expect(matcher.ignoresFile('a/b.cs')).toBe(false);
  });

  test('regex metacharacters in patterns are literal', () => {
    const matcher = m(['file.(1).txt']);
    expect(matcher.ignoresFile('file.(1).txt')).toBe(true);
    expect(matcher.ignoresFile('fileX(1)Ytxt')).toBe(false);
  });

  test('only /**-suffixed patterns prune children', () => {
    const matcher = m(['**/node_modules/**', '**/.*']);
    expect(matcher.ignoresChildren('node_modules')).toBe(true);
    expect(matcher.ignoresChildren('a/node_modules')).toBe(true);
    expect(matcher.ignoresChildren('.git')).toBe(false);
  });
});
