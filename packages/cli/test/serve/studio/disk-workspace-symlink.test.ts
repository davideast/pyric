/**
 * Permanent regression tests for Finding 5 (P2):
 * Studio Workspace Symbolic Link Boundary Traversal Protection.
 *
 * Verifies that resolveWorkspacePath and diskWorkspace operations (read, write,
 * remove, list) reject symbolic links that escape the workspace root directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  diskWorkspace,
  resolveWorkspacePath,
  WorkspacePathError,
} from '../../../src/serve/studio/disk-workspace.js';

describe('diskWorkspace symlink boundary traversal protection (Finding 5)', () => {
  let testDir: string;
  let workspaceRoot: string;
  let outsideDir: string;
  let outsideFile: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'pyric-symlink-reg-'));
    workspaceRoot = join(testDir, 'workspace');
    mkdirSync(workspaceRoot);

    outsideDir = join(testDir, 'outside');
    mkdirSync(outsideDir);

    outsideFile = join(outsideDir, 'sensitive.txt');
    writeFileSync(outsideFile, 'CONFIDENTIAL_DATA', 'utf8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('resolveWorkspacePath', () => {
    it('throws WorkspacePathError when a symlink points to a file outside root', () => {
      const symlinkPath = join(workspaceRoot, 'leak-file.txt');
      symlinkSync(outsideFile, symlinkPath);

      expect(() =>
        resolveWorkspacePath(workspaceRoot, 'leak-file.txt'),
      ).toThrow(WorkspacePathError);
    });

    it('throws WorkspacePathError when a symlink points to a directory outside root', () => {
      const symlinkDir = join(workspaceRoot, 'leak-dir');
      symlinkSync(outsideDir, symlinkDir);

      expect(() =>
        resolveWorkspacePath(workspaceRoot, 'leak-dir/sensitive.txt'),
      ).toThrow(WorkspacePathError);

      expect(() =>
        resolveWorkspacePath(workspaceRoot, 'leak-dir/new-file.txt'),
      ).toThrow(WorkspacePathError);
    });

    it('throws WorkspacePathError when a dangling symlink targets outside root', () => {
      const danglingPath = join(workspaceRoot, 'dangling-escape.txt');
      symlinkSync(join(outsideDir, 'non-existent.txt'), danglingPath);

      expect(() =>
        resolveWorkspacePath(workspaceRoot, 'dangling-escape.txt'),
      ).toThrow(WorkspacePathError);
    });

    it('allows symlinks pointing to files strictly within workspace root', () => {
      const internalFile = join(workspaceRoot, 'internal.txt');
      writeFileSync(internalFile, 'INTERNAL_DATA', 'utf8');

      const internalSymlink = join(workspaceRoot, 'internal-link.txt');
      symlinkSync(internalFile, internalSymlink);

      const resolved = resolveWorkspacePath(workspaceRoot, 'internal-link.txt');
      expect(resolved).toBe(internalSymlink);
    });

    it('allows symlinks pointing to directories strictly within workspace root', () => {
      const internalSubdir = join(workspaceRoot, 'subdir');
      mkdirSync(internalSubdir);
      writeFileSync(join(internalSubdir, 'subfile.txt'), 'SUB', 'utf8');

      const internalDirSymlink = join(workspaceRoot, 'link-subdir');
      symlinkSync(internalSubdir, internalDirSymlink);

      const resolved = resolveWorkspacePath(
        workspaceRoot,
        'link-subdir/subfile.txt',
      );
      expect(resolved).toBe(join(internalDirSymlink, 'subfile.txt'));
    });

    it('allows creating new files inside workspace root when parent does not exist yet', () => {
      const resolved = resolveWorkspacePath(
        workspaceRoot,
        'new/nested/path/file.txt',
      );
      expect(resolved).toBe(
        join(workspaceRoot, 'new', 'nested', 'path', 'file.txt'),
      );
    });
  });

  describe('diskWorkspace store operations through symlinks', () => {
    it('read rejects symlink pointing outside root and preserves confidential data', async () => {
      const symlinkPath = join(workspaceRoot, 'secret-link.txt');
      symlinkSync(outsideFile, symlinkPath);

      const ws = diskWorkspace(workspaceRoot);
      await expect(ws.read('secret-link.txt')).rejects.toThrow(
        WorkspacePathError,
      );
    });

    it('write rejects symlink pointing outside root and does not overwrite outside file', async () => {
      const symlinkPath = join(workspaceRoot, 'overwrite-link.txt');
      symlinkSync(outsideFile, symlinkPath);

      const ws = diskWorkspace(workspaceRoot);
      await expect(
        ws.write('overwrite-link.txt', 'ATTACKER_OVERWRITE'),
      ).rejects.toThrow(WorkspacePathError);

      // Verify outside file was NOT modified
      expect(readFileSync(outsideFile, 'utf8')).toBe('CONFIDENTIAL_DATA');
    });

    it('remove rejects symlink pointing outside root and does not delete outside file', async () => {
      const symlinkPath = join(workspaceRoot, 'delete-link.txt');
      symlinkSync(outsideFile, symlinkPath);

      const ws = diskWorkspace(workspaceRoot);
      await expect(ws.remove('delete-link.txt')).rejects.toThrow(
        WorkspacePathError,
      );

      // Verify outside file still exists
      expect(existsSync(outsideFile)).toBe(true);
    });

    it('list rejects traversing into a symlinked directory outside root', async () => {
      const symlinkDir = join(workspaceRoot, 'outside-dir-link');
      symlinkSync(outsideDir, symlinkDir);

      const ws = diskWorkspace(workspaceRoot);
      await expect(ws.list('outside-dir-link')).rejects.toThrow(
        WorkspacePathError,
      );
    });

    it('allows read and write through internal symlinks within workspace root', async () => {
      const internalFile = join(workspaceRoot, 'target.txt');
      writeFileSync(internalFile, 'ORIGINAL', 'utf8');

      const symlinkPath = join(workspaceRoot, 'internal-alias.txt');
      symlinkSync(internalFile, symlinkPath);

      const ws = diskWorkspace(workspaceRoot);
      expect(await ws.read('internal-alias.txt')).toBe('ORIGINAL');

      await ws.write('internal-alias.txt', 'UPDATED');
      expect(await ws.read('internal-alias.txt')).toBe('UPDATED');
      expect(readFileSync(internalFile, 'utf8')).toBe('UPDATED');
    });
  });
});
