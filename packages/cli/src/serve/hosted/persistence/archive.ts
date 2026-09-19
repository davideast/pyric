import { cpSync, existsSync, mkdtempSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { openNodeSqlite } from './sqlite.js';

/** Called under the project lock, before opening the replacement database. */
export async function archiveHostedDirectory(directory: string): Promise<string | undefined> {
  const missingDirectory = !existsSync(directory);
  if (missingDirectory) return undefined;
  const file = join(directory, 'state.sqlite');
  const healthy = existsSync(file) && await canCheckpointCopy(directory);
  if (healthy) {
    // Preservation is still possible when opening or checkpointing corrupt data fails.
    try {
      const connection = await openNodeSqlite(file);
      try { connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      finally { connection.close(); }
    } catch {
      // Retain the entire directory and its sidecars below, without reading data.
    }
  }
  const archive = `${directory}.archive-${Date.now()}-${randomUUID()}`;
  let attempt = 0;
  let canAttempt = true;
  while (canAttempt) {
    try { renameSync(directory, archive); return archive; }
    catch (error) {
      const hasCode = error instanceof Error && 'code' in error;
      const transient = hasCode && ['EBUSY', 'EPERM', 'EACCES'].includes(String(error.code));
      const canRetry = transient && attempt < 3;
      const exhaustedRetries = !canRetry;
      if (exhaustedRetries) throw new Error('Could not archive hosted state. Close processes using it and retry; the original was preserved.', { cause: error });
      await delay(50 * 2 ** attempt);
      attempt++;
      canAttempt = attempt < 4;
    }
  }
  throw new Error('Could not archive hosted state.');
}

/** Opening SQLite can alter sidecars even on an error: inspect a copy first. */
async function canCheckpointCopy(directory: string): Promise<boolean> {
  const scratch = mkdtempSync(join(tmpdir(), 'pyric-archive-check-'));
  try {
    const copy = join(scratch, 'state');
    cpSync(directory, copy, { recursive: true });
    const connection = await openNodeSqlite(join(copy, 'state.sqlite'), true);
    try {
      return connection.prepare('PRAGMA quick_check').all().every(row => row.quick_check === 'ok');
    } finally { connection.close(); }
  } catch { return false; }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
