/**
 * Seeding. Applies an `EvalSeed` to a fresh sandbox through
 * `applyRules`/`applyData` (the sandbox tool's `seed` method uses the same
 * two functions against a live sandbox), then persists the result with the v3
 * bundle codec the headless server reads on start. The agent under test
 * therefore begins every task with state it did not create, and no task spends
 * tool calls on setup.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { applyData, applyRules } from '../src/bridge/surface/seed-apply.js';
import { saveSandboxSnapshot } from '../src/bridge/server/headless.js';
import { saveStorageSidecar } from './storage-sidecar.js';
import { CAPTURE_RELATIVE_PATH } from '../src/serve/capture-store.js';
import type { EvalSeed } from './types.js';

export { applyData, applyRules };

/** Filenames the seed writes into the run directory, one per rules service. */
export const FIRESTORE_RULES_FILE = 'firestore.rules';
export const DATABASE_RULES_FILE = 'database.rules.json';
export const STORAGE_RULES_FILE = 'storage.rules';

/**
 * Write the capture a seed declares into the run's project directory.
 *
 * A recorded session is not sandbox state, so it does not travel through the
 * snapshot the way documents and accounts do. It is a file the app left
 * behind, and a task that asks an agent to replay the last session needs one
 * on disk before the server starts.
 */
export async function writeSessionFile(dir: string, seed: EvalSeed): Promise<void> {
  const record = seed.session;
  if (record === undefined) return;
  const session = await record();
  const path = join(dir, CAPTURE_RELATIVE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session)}\n`, 'utf8');
}

/**
 * Write each file a seed declares under `projectFiles` into the run's project
 * directory, creating whatever parent directories the relative path needs.
 */
export function writeProjectFiles(dir: string, seed: EvalSeed): void {
  const files = seed.projectFiles;
  if (files === undefined) return;
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(dir, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
}

/** Write each declared rules source into the run directory as its own file. */
export function writeRulesFiles(dir: string, seed: EvalSeed): void {
  mkdirSync(dir, { recursive: true });
  const firestoreRules = seed.firestoreRules;
  if (firestoreRules !== undefined) {
    writeFileSync(join(dir, FIRESTORE_RULES_FILE), firestoreRules, 'utf8');
  }
  const databaseRules = seed.databaseRules;
  if (databaseRules !== undefined) {
    writeFileSync(join(dir, DATABASE_RULES_FILE), databaseRules, 'utf8');
  }
  const storageRules = seed.storageRules;
  if (storageRules !== undefined) {
    writeFileSync(join(dir, STORAGE_RULES_FILE), storageRules, 'utf8');
  }
}

/**
 * Apply a seed to a fresh sandbox and persist it as `<dir>/.pyric/state/headless.json`,
 * alongside the rules files. Returns the sandbox so a caller that wants to
 * inspect the pre-run state does not have to read the file back.
 */
export async function applySeed(dir: string, seed: EvalSeed): Promise<LocalSandbox> {
  const sandbox = initializeSandbox();
  await applyRules(sandbox, seed);
  await applyData(sandbox, seed);
  writeRulesFiles(dir, seed);
  writeProjectFiles(dir, seed);
  await writeSessionFile(dir, seed);
  saveSandboxSnapshot(sandbox, dir);
  await saveStorageSidecar(getAdminStorageSandbox(sandbox), dir);
  return sandbox;
}
