import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  adminUnobservedLine,
  createAdminTree,
  createAdminUnobserved,
  isAdminTreeImporter,
  isAdminTreeReload,
  isNodeModulesPath,
  joinAdminTree,
  unobservedFields,
} from '../../src/register/admin-tree.js';

describe('admin-tree', () => {
  it('tracks file URLs in the Admin SDK tree while excluding instrumentation packages and non-file URLs', () => {
    const root = mkdtempSync(join(tmpdir(), 'admin-tree-'));
    try {
      const adminDir = join(root, 'node_modules', 'firebase-admin');
      const ritmDir = join(root, 'node_modules', 'require-in-the-middle');
      mkdirSync(join(adminDir, 'lib'), { recursive: true });
      mkdirSync(ritmDir, { recursive: true });
      writeFileSync(join(adminDir, 'package.json'), JSON.stringify({ name: 'firebase-admin' }));
      writeFileSync(join(ritmDir, 'package.json'), JSON.stringify({ name: 'require-in-the-middle' }));
      const adminEntry = join(adminDir, 'lib', 'index.js');
      const ritmEntry = join(ritmDir, 'index.js');
      writeFileSync(adminEntry, '');
      writeFileSync(ritmEntry, '');

      const tree = createAdminTree();
      const adminUrl = pathToFileURL(adminEntry).href;
      const ritmUrl = pathToFileURL(ritmEntry).href;

      joinAdminTree(tree, { url: adminUrl });
      joinAdminTree(tree, { url: ritmUrl });
      joinAdminTree(tree, { url: 'node:fs' });

      expect(tree.has(adminUrl)).toBe(true);
      expect(isAdminTreeImporter(tree, adminUrl)).toBe(true);
      expect(isAdminTreeImporter(tree, undefined)).toBe(false);
      expect(tree.has(ritmUrl)).toBe(false);
      expect(tree.has('node:fs')).toBe(false);
      expect(tree.hasPackageDir(adminDir)).toBe(true);
      expect(isAdminTreeReload(tree, adminEntry, undefined, adminUrl)).toBe(true);
      expect(isAdminTreeReload(tree, 'firebase-admin', undefined, adminUrl)).toBe(false);
      expect(isNodeModulesPath(adminEntry)).toBe(true);
      expect(isNodeModulesPath('/app/src/index.js')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records unobserved and gated Admin subpaths once in load order', () => {
    const lines: string[] = [];
    let changeCount = 0;
    const unobserved = createAdminUnobserved(
      (line) => lines.push(line),
      () => {
        changeCount += 1;
      },
    );

    expect(unobservedFields(unobserved)).toEqual({});
    unobserved.note('firebase-admin/remote-config');
    unobserved.note('firebase-admin/remote-config');
    unobserved.noteGated('firebase-admin/app-check');
    unobserved.noteGated('firebase-admin/app-check');

    expect(lines).toEqual([`${adminUnobservedLine('firebase-admin/remote-config')}\n`]);
    expect(changeCount).toBe(2);
    expect(unobservedFields(unobserved)).toEqual({
      unobservedAdmin: ['firebase-admin/remote-config'],
      gatedAdmin: ['firebase-admin/app-check'],
    });
  });
});
