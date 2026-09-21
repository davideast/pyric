import { openNodeSqlite } from './persistence/sqlite.js';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Which group of state files a claim protects. One lock per group: processes
 * that write different files under `.pyric/state` run at the same time, so an
 * editor's in-process MCP sandbox does not keep the Node host from starting.
 *
 * - `in-process`: `.pyric/state/in-process.json` and `.pyric/state/storage.json`
 * - `host`: the Node host's `.pyric/state/hosted` directory
 * - `browser-state`: the served sandbox's `.pyric/state/state.json`
 */
export type ProjectStateScope = 'in-process' | 'host' | 'browser-state';

const SCOPE_LOCKS: Record<ProjectStateScope, string> = {
  'in-process': 'in-process.lock',
  host: 'host.lock',
  'browser-state': 'browser-state.lock',
};

const SCOPE_REFUSALS: Record<ProjectStateScope, string> = {
  'in-process': 'An in-process sandbox already owns this project\'s in-process state. Stop it before starting another in-process sandbox.',
  host: 'A hosted sandbox already owns this project\'s hosted state. Attach to its bridge or stop it before starting another hosted sandbox.',
  'browser-state': 'A served sandbox already owns this project\'s persisted state file. Attach to its bridge or stop it before starting another one.',
};

async function openOwnershipFile(path: string) {
  const runsOnBun = typeof process.versions.bun === 'string';
  if (runsOnBun) {
    const { Database } = await import('bun:sqlite');
    return new Database(path, { create: true });
  }
  return openNodeSqlite(path);
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

/** Hold one scope's state files until teardown or process termination. */
export async function claimProjectState(projectDir: string, scope: ProjectStateScope) {
  const stateDir = join(realpathSync(projectDir), '.pyric', 'state');
  mkdirSync(stateDir, { recursive: true });
  // Never remove this file: replacement would let another process lock a
  // different inode. The database stores no application data; its write
  // reservation supplies the OS lock and rolls back when the owner closes.
  const ownership = await openOwnershipFile(join(stateDir, SCOPE_LOCKS[scope]));
  try {
    ownership.exec('PRAGMA busy_timeout = 0; BEGIN IMMEDIATE');
  } catch (error) {
    ownership.close();
    const hasAnotherOwner = isOwnershipBusy(error);
    if (hasAnotherOwner) throw new Error(SCOPE_REFUSALS[scope]);
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
