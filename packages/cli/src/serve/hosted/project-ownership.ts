import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

async function openOwnershipFile(path: string) {
  const runsOnBun = typeof process.versions.bun === 'string';
  if (runsOnBun) {
    const { Database } = await import('bun:sqlite');
    return new Database(path, { create: true });
  }
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path);
}

function isOwnershipBusy(error: unknown): boolean {
  const hasCode = error instanceof Error && 'code' in error;
  if (hasCode) {
    const isBunBusy = error.code === 'SQLITE_BUSY';
    if (isBunBusy) return true;
  }
  const hasErrorNumber = error instanceof Error && 'errcode' in error;
  if (hasErrorNumber) return error.errcode === 5;
  return false;
}

/** Hold the canonical state directory until teardown or process termination. */
export async function claimProjectState(projectDir: string) {
  const stateDir = join(realpathSync(projectDir), '.pyric', 'state');
  mkdirSync(stateDir, { recursive: true });
  // Never remove this file: replacement would let another process lock a
  // different inode. The database stores no application data; its write
  // reservation supplies the OS lock and rolls back when the owner closes.
  const ownership = await openOwnershipFile(join(stateDir, 'host.lock'));
  try {
    ownership.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
  } catch (error) {
    ownership.close();
    const hasAnotherOwner = isOwnershipBusy(error);
    if (hasAnotherOwner) throw new Error('A sandbox already owns this project\'s persisted state. Attach to its bridge or stop it before starting another sandbox.');
    throw error;
  }
  let closed = false;
  return {
    close(): void {
      if (closed) return;
      closed = true;
      ownership.close();
    },
  };
}
