import { requireNodePersistence } from './persistence/sqlite.js';
import { join } from 'node:path';
import { openHostedDatabase } from './persistence/database.js';
import { createHostedStateView } from './persistence/state-view.js';
import { validateHostedDatabase, type StorageMetadataRepair } from './persistence/validate.js';
import { archiveHostedDirectory } from './persistence/archive.js';

export const HOSTED_NAMESPACE = 'hosted';
export const hostedStateDirectory = (projectDir: string): string => join(projectDir, '.pyric', 'state', 'hosted');

/** Node owns one durable store; existing browser/MCP files are unrelated. */
export async function createHostedPersistence(projectDir: string, options: { fresh?: boolean } = {}) {
  requireNodePersistence();
  const directory = hostedStateDirectory(projectDir);
  let archive: string | undefined;
  const startsFresh = options.fresh === true;
  if (startsFresh) archive = await archiveHostedDirectory(directory);
  const database = await openHostedDatabase(directory).catch(error => { throw restorationFailure(directory, error); });
  try {
    const repairedObjects = validateHostedDatabase(database);
    database.activate();
    const state = createHostedStateView(projectDir, directory, database, HOSTED_NAMESPACE);
    const savedArchive = archive;
    const hasArchive = savedArchive !== undefined;
    if (hasArchive) state.backupPath = savedArchive;
    return {
      backend: database.records, storage: database.storage, state, repairedObjects, close: database.close,
      status: database.status, onFailure: database.onFailure, markUnhealthy: database.markUnhealthy,
      seed: state.seed,
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

/** Startup lines naming each Storage object the stored bytes corrected. */
export function formatStorageRepairs(repairs: readonly StorageMetadataRepair[]): string[] {
  const nothingRepaired = repairs.length === 0;
  if (nothingRepaired) return [];
  return [
    '  ⚠ Repaired Storage metadata that disagreed with the stored bytes; the bytes are unchanged.',
    ...repairs.map(repair => `    • ${repair.bucket}/${repair.path}: recorded size ${repair.recordedSize}, actual size ${repair.actualSize}`),
  ];
}

function restorationFailure(directory: string, cause: unknown): Error {
  return new Error(`Hosted state could not be restored. Preserve '${directory}' and run pyric sandbox salvage --source <hosted-directory> --out <new-directory>.`, { cause });
}
