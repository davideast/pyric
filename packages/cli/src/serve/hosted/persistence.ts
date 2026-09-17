import type { PyricStateFile } from '../state-file.js';
import { requireNodePersistence } from './persistence/sqlite.js';
import { join } from 'node:path';
import { openHostedDatabase } from './persistence/database.js';
import { createHostedStateView } from './persistence/state-view.js';
import { validateHostedDatabase } from './persistence/validate.js';
import { archiveHostedDirectory } from './persistence/archive.js';

export const HOSTED_NAMESPACE = 'hosted';
export const hostedStateDirectory = (projectDir: string): string => join(projectDir, '.pyric', 'state', 'hosted');

/** Node owns one durable store; legacy browser/MCP files are unrelated. */
export async function createHostedPersistence(projectDir: string, options: { fresh?: boolean } = {}) {
  requireNodePersistence();
  const directory = hostedStateDirectory(projectDir);
  let archive: string | undefined;
  const startsFresh = options.fresh === true;
  if (startsFresh) archive = await archiveHostedDirectory(directory);
  const database = await openHostedDatabase(directory).catch(error => { throw restorationFailure(directory, error); });
  try {
    validateHostedDatabase(database);
    const state = createHostedStateView(projectDir, directory, database, HOSTED_NAMESPACE);
    const savedArchive = archive;
    const hasArchive = savedArchive !== undefined;
    if (hasArchive) state.backupPath = savedArchive;
    return {
      history: database.history,
      backend: database.records, storage: database.storage, state, close: database.close,
      status: database.status, onFailure: database.onFailure, markUnhealthy: database.markUnhealthy,
      seed(fixture: PyricStateFile): void {
        database.commit(() => {
          const hasFirestore = fixture.firestore != null;
          if (hasFirestore) state.writeSection('firestore', fixture.firestore);
          const hasAuth = fixture.auth != null;
          if (hasAuth) state.writeSection('auth', fixture.auth);
          const hasStorage = fixture.storage !== undefined;
          if (hasStorage) state.writeSection('storage', fixture.storage);
          validateHostedDatabase(database);
        });
      },
    };
  } catch (error) {
    database.close();
    throw restorationFailure(directory, error);
  }
}

export type HostedPersistence = Awaited<ReturnType<typeof createHostedPersistence>>;

/** Consistent offline export; read-only opening never creates a missing database. */
export async function loadHostedSnapshot(projectDir: string) {
  const directory = hostedStateDirectory(projectDir);
  const database = await openHostedDatabase(directory, { readOnly: true });
  try {
    validateHostedDatabase(database);
    return createHostedStateView(projectDir, directory, database, HOSTED_NAMESPACE).load();
  } finally { database.close(); }
}

function restorationFailure(directory: string, cause: unknown): Error {
  return new Error(`Hosted state could not be restored. Preserve '${directory}' and run pyric sandbox salvage --source <hosted-directory> --out <new-directory>.`, { cause });
}
