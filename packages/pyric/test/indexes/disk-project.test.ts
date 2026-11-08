import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDiskProject } from '../../src/indexes/disk-project.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadDiskProject', () => {
  test('locates unified project root with tsconfig.json, skips symlinks, and computes clientRoots', () => {
    const project = makeTempDir('pyric-disk-proj-');
    const outside = makeTempDir('pyric-disk-outside-');
    mkdirSync(join(project, 'src', 'lib'), { recursive: true });
    mkdirSync(join(project, 'src', 'pages'), { recursive: true });
    writeFileSync(join(project, 'tsconfig.json'), '{"compilerOptions":{"baseUrl":"."}}');
    writeFileSync(join(project, 'src', 'lib', 'helper.ts'), 'export const h = 1;');
    writeFileSync(join(project, 'src', 'pages', 'home.ts'), 'import { h } from "../lib/helper"; export const p = h;');
    writeFileSync(join(outside, 'secret.ts'), 'export const s = 2;');
    symlinkSync(join(outside, 'secret.ts'), join(project, 'src', 'pages', 'link.ts'));

    const loaded = loadDiskProject([join(project, 'src', 'pages')]);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.configs.map((c) => c.name)).toEqual(['tsconfig.json']);
      expect(loaded.files.map((f) => f.name).sort()).toEqual(['src/lib/helper.ts', 'src/pages/home.ts']);
      expect(loaded.clientRoots).toEqual(['src/pages']);
    }

    const directSymlink = loadDiskProject(['src/pages/link.ts'], project);
    expect(directSymlink.ok).toBe(false);
    if (!directSymlink.ok) {
      expect(directSymlink.recoverable).toBe(false);
      expect(directSymlink.message).toContain('symbolic links');
    }
  });

  test('stops upward root search before excluded test directories', () => {
    const project = makeTempDir('pyric-disk-testdir-');
    mkdirSync(join(project, 'test', 'fixtures'), { recursive: true });
    writeFileSync(join(project, 'package.json'), '{"name":"pkg"}');
    writeFileSync(join(project, 'test', 'fixtures', 'sample.ts'), 'export const x = 1;');

    const loaded = loadDiskProject([join(project, 'test', 'fixtures', 'sample.ts')], project);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.files.map((f) => f.name)).toEqual(['sample.ts']);
      expect(loaded.clientRoots).toEqual(['sample.ts']);
    }
  });
});
