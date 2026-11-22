import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModules } from '../../src/modules/resolver.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function sourceImporting(specifier: string, fnName = 'canRead'): string {
  return `rules_version = '2+modules';
import { ${fnName} } from '${specifier}';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} { allow read: if ${fnName}(); }
  }
}`;
}

describe('resolveModules disk containment (#1446)', () => {
  test('refuses relative .. traversal and symlinks that escape basePath', () => {
    const root = makeTempDir('pyric-rules-contain-');
    const project = join(root, 'project');
    const outside = join(root, 'outside');
    mkdirSync(join(project, 'sub'), { recursive: true });
    mkdirSync(outside, { recursive: true });

    const outsideModule = "rules_version = '2+modules';\nexport function canRead() { return true; }\n";
    writeFileSync(join(outside, 'secret.rules'), outsideModule, 'utf-8');
    symlinkSync(join(outside, 'secret.rules'), join(project, 'escape-file.rules'));
    symlinkSync(outside, join(project, 'escape-dir'));

    const traversal = resolveModules(sourceImporting('../outside/secret'), { basePath: project });
    expect(traversal.success).toBe(false);
    if (!traversal.success) {
      expect(traversal.error.code).toBe('UNKNOWN_MODULE');
      expect(traversal.error.message).toContain('../outside/secret');
    }

    const fileSymlink = resolveModules(sourceImporting('./escape-file'), { basePath: project });
    expect(fileSymlink.success).toBe(false);
    if (!fileSymlink.success) {
      expect(fileSymlink.error.code).toBe('UNKNOWN_MODULE');
      expect(fileSymlink.error.message).toContain('./escape-file');
    }

    const dirSymlink = resolveModules(sourceImporting('./escape-dir/secret'), { basePath: project });
    expect(dirSymlink.success).toBe(false);
    if (!dirSymlink.success) {
      expect(dirSymlink.error.code).toBe('UNKNOWN_MODULE');
      expect(dirSymlink.error.message).toContain('./escape-dir/secret');
    }

    const bareTraversal = resolveModules(sourceImporting('auth/../../../../outside/secret'), {
      basePath: project,
    });
    expect(bareTraversal.success).toBe(false);
    if (!bareTraversal.success) {
      expect(bareTraversal.error.code).toBe('UNKNOWN_MODULE');
    }
  });

  test('accepts .. segments and symlinks whose real location stays inside basePath', () => {
    const root = makeTempDir('pyric-rules-contain-ok-');
    const project = join(root, 'project');
    mkdirSync(join(project, 'sub'), { recursive: true });
    writeFileSync(
      join(project, 'shared.rules'),
      "rules_version = '2+modules';\nexport function canRead() { return request.auth != null; }\n",
      'utf-8',
    );
    writeFileSync(
      join(project, 'sub', 'entry.rules'),
      "rules_version = '2+modules';\nimport { canRead } from '../shared';\nexport function allowItem() { return canRead(); }\n",
      'utf-8',
    );
    symlinkSync(join(project, 'shared.rules'), join(project, 'alias.rules'));

    const nestedBack = resolveModules(sourceImporting('./sub/entry', 'allowItem'), {
      basePath: project,
    });
    expect(nestedBack.success).toBe(true);
    if (nestedBack.success) {
      expect(nestedBack.data.resolved).toContain('function allowItem()');
      expect(nestedBack.data.resolved).toContain('function canRead()');
    }

    const internalSymlink = resolveModules(sourceImporting('./alias'), { basePath: project });
    expect(internalSymlink.success).toBe(true);
    if (internalSymlink.success) {
      expect(internalSymlink.data.resolved).toContain('function canRead()');
    }
  });

  test('refuses symlink + .. traversal tricks that lexically look inside basePath', () => {
    const root = makeTempDir('pyric-rules-contain-trick-');
    const project = join(root, 'project');
    const outsideDeep = join(root, 'outside', 'deep');
    mkdirSync(project, { recursive: true });
    mkdirSync(outsideDeep, { recursive: true });
    writeFileSync(
      join(root, 'outside', 'secret.rules'),
      "rules_version = '2+modules';\nexport function leaked() { return true; }\n",
      'utf-8',
    );
    writeFileSync(
      join(project, 'secret.rules'),
      "rules_version = '2+modules';\nexport function leaked() { return false; }\n",
      'utf-8',
    );
    symlinkSync(outsideDeep, join(project, 'escape_deep'));
    symlinkSync('escape_deep/../secret.rules', join(project, 'trick.rules'));

    for (const spec of ['./trick', './escape_deep/../secret']) {
      const res = resolveModules(sourceImporting(spec, 'leaked'), { basePath: project });
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error.code).toBe('UNKNOWN_MODULE');
        expect(res.error.message).toContain(spec);
      }
    }
  });
});
