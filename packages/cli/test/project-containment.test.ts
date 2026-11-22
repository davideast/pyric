import { describe, expect, it } from 'bun:test';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getCanonicalPath,
  isContained,
  PathContainmentCycleError,
  PathContainmentTraversalError,
  realPathWithin,
} from '../src/project-containment.js';
import { useTempDirs } from './use-temp-dirs.js';

const makeTempDir = useTempDirs('pyric-project-containment-');

describe('project-containment', () => {
  it('accepts direct files, nested missing targets, and internal symlinks', () => {
    const base = makeTempDir();
    const root = join(base, 'project');
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'sub', 'data.json'), '{"ok":true}', 'utf8');
    symlinkSync(join(root, 'sub', 'data.json'), join(root, 'file-link.json'));
    symlinkSync(join(root, 'sub'), join(root, 'dir-link'));

    const canonicalRoot = realpathSync(root);
    expect(realPathWithin(root, 'sub/data.json')).toBe(join(canonicalRoot, 'sub', 'data.json'));
    expect(realPathWithin(root, 'file-link.json')).toBe(join(canonicalRoot, 'sub', 'data.json'));
    expect(realPathWithin(root, 'dir-link/data.json')).toBe(join(canonicalRoot, 'sub', 'data.json'));
    expect(realPathWithin(root, 'dir-link/new-child.json')).toBe(
      join(canonicalRoot, 'sub', 'new-child.json'),
    );
    expect(realPathWithin(root, 'missing/deep/out.json')).toBe(
      join(canonicalRoot, 'missing', 'deep', 'out.json'),
    );
    expect(realPathWithin(root, 'sub/../sub/data.json')).toBe(
      join(canonicalRoot, 'sub', 'data.json'),
    );
  });

  it('refuses traversals, prefix collisions, outside symlinks, dangling escapes, chains, cycles, and NUL bytes', () => {
    const base = makeTempDir();
    const root = join(base, 'project');
    const sibling = join(base, 'project-evil');
    const outside = join(base, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(sibling, 'secret.txt'), 'nope', 'utf8');
    writeFileSync(join(outside, 'secret.txt'), 'nope', 'utf8');

    symlinkSync(join(outside, 'secret.txt'), join(root, 'escape-file.txt'));
    symlinkSync(outside, join(root, 'escape-dir'));
    symlinkSync(join(outside, 'missing.txt'), join(root, 'dangling-escape.txt'));
    symlinkSync(join(outside, 'missing-dir'), join(root, 'dangling-dir'));
    symlinkSync(join(root, 'dangling-escape.txt'), join(root, 'chain-escape.txt'));
    symlinkSync(join(root, 'loop-b'), join(root, 'loop-a'));
    symlinkSync(join(root, 'loop-a'), join(root, 'loop-b'));

    expect(realPathWithin(root, '../outside/secret.txt')).toBeNull();
    expect(realPathWithin(root, join(sibling, 'secret.txt'))).toBeNull();
    expect(realPathWithin(root, 'escape-file.txt')).toBeNull();
    expect(realPathWithin(root, 'escape-dir/secret.txt')).toBeNull();
    expect(realPathWithin(root, 'escape-dir/new/export.json')).toBeNull();
    expect(realPathWithin(root, 'dangling-escape.txt')).toBeNull();
    expect(realPathWithin(root, 'dangling-dir/nested/out.json')).toBeNull();
    expect(realPathWithin(root, 'chain-escape.txt')).toBeNull();
    expect(realPathWithin(root, 'loop-a')).toBeNull();
    expect(realPathWithin(root, 'safe\0.txt')).toBeNull();

    expect(() => getCanonicalPath(join(root, 'loop-a'))).toThrow(PathContainmentCycleError);
    expect(isContained('/a/b', '/a/b')).toBe(true);
    expect(isContained('/a/b', '/a/b/c')).toBe(true);
    expect(isContained('/a/b', '/a/bc')).toBe(false);
  });

  it('resolves symlink + .. left-to-right and fails closed on .. across missing or non-directory segments', () => {
    const base = makeTempDir();
    const root = join(base, 'project');
    const outsideDeep = join(base, 'outside', 'deep');
    mkdirSync(root, { recursive: true });
    mkdirSync(outsideDeep, { recursive: true });
    writeFileSync(join(root, 'inside.txt'), 'inside', 'utf8');

    symlinkSync(outsideDeep, join(root, 'escape_dir'));
    symlinkSync('escape_dir/../pwned.txt', join(root, 'trick'));
    symlinkSync('escape_dir/./../pwned2.txt', join(root, 'trick2'));
    symlinkSync('escape_dir/nonexistent/../../../project/inside.txt', join(root, 'trick3'));
    symlinkSync('inside.txt/../inside.txt', join(root, 'file_bounce'));

    expect(realPathWithin(root, 'trick')).toBeNull();
    expect(realPathWithin(root, 'trick2')).toBeNull();
    expect(realPathWithin(root, 'escape_dir/../pwned.txt')).toBeNull();
    expect(realPathWithin(root, join(root, 'escape_dir') + '/../pwned.txt')).toBeNull();
    expect(realPathWithin(root, 'trick3')).toBeNull();
    expect(realPathWithin(root, 'file_bounce')).toBeNull();
    expect(realPathWithin(root, 'missing/../inside.txt')).toBeNull();

    expect(() => getCanonicalPath(join(root, 'trick3'))).toThrow(PathContainmentTraversalError);
    expect(() => getCanonicalPath(join(root, 'file_bounce'))).toThrow(PathContainmentTraversalError);
    expect(getCanonicalPath(join(root, 'trick'))).toBe(join(realpathSync(join(base, 'outside')), 'pwned.txt'));
  });
});
