/** What a round was built from: the main commit and the hash of each tarball its builders installed. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Tarballs } from '../apps/install.ts';

export interface Provenance {
  commit: string;
  /** The checkout had changes beyond the commit when it was packed. */
  dirty: boolean;
  /** Package name to the sha256 of its tarball. */
  tarballs: Record<string, string>;
}

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function provenance(repoRoot: string, tarballs: Tarballs): Provenance {
  return {
    commit: git(repoRoot, ['rev-parse', 'HEAD']),
    dirty: git(repoRoot, ['status', '--porcelain']) !== '',
    tarballs: Object.fromEntries([...tarballs].map(([name, file]) => [name, sha256File(file)])),
  };
}
