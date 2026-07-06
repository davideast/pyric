/**
 * One-time legacy workspace migration.
 *
 * Before session containers landed, every session and every tab wrote
 * to ONE origin-global OPFS tree at `/workspace` (including the
 * checkpoints git repo at `/workspace/.git`). This module recovers
 * that tree into a session container so nobody loses work on first
 * load with the scoped-adapter code:
 *
 *   /workspace/**  →  {containerRealRoot}/workspace/**
 *
 * then deletes the legacy root. Idempotent by construction — after a
 * successful migration the legacy root is gone, so subsequent loads
 * are a cheap ENOENT no-op. A partially-failed migration retries
 * safely: files already present at the destination are skipped, never
 * overwritten.
 *
 * Implemented purely against the `OPFSAdapter` promises API so it can
 * be unit-tested headlessly against the in-memory adapter.
 */

import type { OPFSAdapter } from './opfs-adapter';

export const LEGACY_WORKSPACE_ROOT = '/workspace';

export interface LegacyMigrationResult {
  /** True when a legacy `/workspace` existed and was moved. */
  migrated: boolean;
  /** Number of files (incl. symlinks) copied into the container. */
  files: number;
}

interface ErrnoLike {
  code?: string;
}

function isCode(err: unknown, code: string): boolean {
  return (err as ErrnoLike | null)?.code === code;
}

async function exists(raw: OPFSAdapter, path: string): Promise<boolean> {
  try {
    await raw.promises.lstat(path);
    return true;
  } catch (err) {
    if (isCode(err, 'ENOENT')) return false;
    throw err;
  }
}

/**
 * Move the legacy global `/workspace` (if present) into
 * `{containerRealRoot}/workspace`. `raw` must be the UNSCOPED adapter
 * — both the legacy root and the container are addressed in real
 * OPFS coordinates here.
 */
export async function migrateLegacyWorkspace(
  raw: OPFSAdapter,
  containerRealRoot: string,
): Promise<LegacyMigrationResult> {
  if (!(await exists(raw, LEGACY_WORKSPACE_ROOT))) {
    return { migrated: false, files: 0 };
  }
  const dest = `${containerRealRoot}${LEGACY_WORKSPACE_ROOT}`;
  const files = await copyTree(raw, LEGACY_WORKSPACE_ROOT, dest, containerRealRoot);
  // Copy succeeded — drop the legacy root so the migration never
  // re-runs (and so no future code can silently fall back to it).
  await raw.promises.rmdir(LEGACY_WORKSPACE_ROOT, { recursive: true });
  return { migrated: true, files };
}

async function copyTree(
  raw: OPFSAdapter,
  src: string,
  dest: string,
  containerRealRoot: string,
): Promise<number> {
  const fs = raw.promises;
  await fs.mkdir(dest, { recursive: true });
  let files = 0;
  const names = await fs.readdir(src);
  for (const name of names) {
    const srcPath = `${src}/${name}`;
    const destPath = `${dest}/${name}`;
    const stats = await fs.lstat(srcPath);
    if (stats.isDirectory()) {
      files += await copyTree(raw, srcPath, destPath, containerRealRoot);
      continue;
    }
    if (await exists(raw, destPath)) continue; // retry-safe: never overwrite
    if (stats.isSymbolicLink()) {
      const target = await fs.readlink(srcPath);
      // Legacy absolute targets pointed into the global /workspace;
      // re-aim them at the container so the link resolves post-move.
      const translated = target.startsWith(`${LEGACY_WORKSPACE_ROOT}/`) || target === LEGACY_WORKSPACE_ROOT
        ? `${containerRealRoot}${target}`
        : target;
      await fs.symlink(translated, destPath);
      files += 1;
      continue;
    }
    // Plain file — copy bytes (no encoding: round-trips binary
    // content like the checkpoints git repo's packfiles).
    const bytes = await fs.readFile(srcPath);
    await fs.writeFile(destPath, bytes);
    files += 1;
  }
  return files;
}
