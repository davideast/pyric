import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

function lstatOrNull(targetPath: string) {
  try {
    return lstatSync(targetPath);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

function assertNotSymlinkDirectory(dirPath: string): void {
  const stat = lstatOrNull(dirPath);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to write session file through symbolic link directory: ${dirPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Session parent path is not a directory: ${dirPath}`);
  }
}

function ensureSafeParentDirectory(filePath: string): string {
  const resolvedFile = resolve(filePath);
  const targetDir = dirname(resolvedFile);

  // Check every ancestor from any `.pyric` segment down to `targetDir` (without tripping on OS symlinks like `/var` or `/tmp`).
  const checkDirs: string[] = [];
  let cursor = targetDir;
  let sawDotPyric = false;
  for (;;) {
    checkDirs.push(cursor);
    if (basename(cursor) === '.pyric') {
      sawDotPyric = true;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  let guardedAncestors: string[];
  if (sawDotPyric) {
    checkDirs.reverse();
    guardedAncestors = checkDirs;
  } else {
    guardedAncestors = [targetDir];
  }
  for (const dirPath of guardedAncestors) {
    assertNotSymlinkDirectory(dirPath);
  }

  // Create any missing parent segments step-by-step, verifying each created or existing segment is a real directory.
  const missingSegments: string[] = [];
  let walk = targetDir;
  for (;;) {
    const stat = lstatOrNull(walk);
    if (stat !== null) {
      const isNonRootExistingParent = missingSegments.length > 0 && dirname(walk) !== '/';
      if (
        stat.isSymbolicLink() &&
        (walk === targetDir || basename(walk) === '.pyric' || isNonRootExistingParent)
      ) {
        throw new Error(`Refusing to write session file through symbolic link directory: ${walk}`);
      }
      break;
    }
    missingSegments.push(walk);
    const parent = dirname(walk);
    if (parent === walk) break;
    walk = parent;
  }
  missingSegments.reverse();
  for (const segmentDir of missingSegments) {
    assertNotSymlinkDirectory(segmentDir);
    try {
      mkdirSync(segmentDir, { mode: 0o700 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
    }
    assertNotSymlinkDirectory(segmentDir);
  }
  assertNotSymlinkDirectory(targetDir);
  return targetDir;
}

/**
 * Atomically writes `content` to `filePath` via a sibling `0o600` temporary file
 * and `renameSync`, refusing symlinked `.pyric` parent directories and replacing
 * any pre-existing leaf symlink without following it.
 */
export function writeMode600FileSync(filePath: string, content: string): void {
  const dir = ensureSafeParentDirectory(filePath);
  const tmpPath = join(
    dir,
    `.${basename(filePath)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`,
  );
  let fd: number | undefined;
  try {
    const openFlags =
      fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      (fsConstants.O_NOFOLLOW ?? 0);
    fd = openSync(tmpPath, openFlags, 0o600);
    writeFileSync(fd, content, 'utf8');
    closeSync(fd);
    fd = undefined;
    try {
      chmodSync(tmpPath, 0o600);
    } catch {
      // Best-effort on filesystems without POSIX chmod semantics.
    }
    renameSync(tmpPath, resolve(filePath));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close error during cleanup.
      }
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best-effort temp cleanup.
    }
    throw error;
  }
}
