/**
 * Named on-disk snapshots of the live sandbox, restorable by name.
 *
 * A checkpoint captures the whole sandbox: Firestore documents, the Realtime
 * Database tree and its rules, auth users with their tenant, claims, and real
 * password, Storage objects, and the Firestore and Storage rules text (the
 * database's own rules travel inside the bundle already, because the RTDB
 * persistable service snapshots them itself). This is the same v3 bundle codec
 * `pyric mcp --headless` uses for its own `.pyric/state/headless.json`
 * (`serializeToBuckets` + `bundleRecords`), so a checkpoint restores through
 * the one clobber seam the sandbox already exposes, `loadSnapshot`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  bundleRecords,
  deserializeFromBuckets,
  parseBundle,
  serializeToBuckets,
  type LocalSandbox,
  type SandboxSnapshot,
} from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import {
  getAdminStorageSandbox,
  getStorageRulesResolution,
  replaceStorageRules,
} from 'pyric/storage/internal';
import { deleteObject, ref as storageRef } from 'pyric/storage';
import {
  exportStorage,
  listStoredPaths,
  restoreStorage,
  type StorageObjectRecord,
} from './storage-state.js';

/** A checkpoint name: portable across filesystems, safe as a bare filename. */
export const CHECKPOINT_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Where checkpoints for one project live. */
function checkpointsDir(projectDir: string): string {
  return join(projectDir, '.pyric', 'state', 'checkpoints');
}

/** The file one checkpoint is stored at. */
export function checkpointPath(projectDir: string, name: string): string {
  return join(checkpointsDir(projectDir), `${name}.json`);
}

/** Every checkpoint name saved for one project, sorted. */
export function checkpointNames(projectDir: string): string[] {
  const dir = checkpointsDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

/** Per-service counts recorded on a checkpoint, for `listCheckpoints`. */
export interface CheckpointCounts {
  firestore: number;
  database: number;
  storage: number;
  auth: number;
}

/** The envelope one checkpoint file holds. */
export interface CheckpointFile {
  version: 1;
  at: number;
  counts: CheckpointCounts;
  bundle: string;
  firestoreRules: string;
  storageRules: string | null;
  storage: StorageObjectRecord[];
}

/** The database tree's top-level key count, for the counts a listing reports. */
function databaseEntryCount(services: Record<string, unknown>): number {
  const rtdb = services.rtdb as { data?: Record<string, unknown> } | undefined;
  const data = rtdb?.data;
  if (data === undefined || data === null || typeof data !== 'object') return 0;
  return Object.keys(data).length;
}

/** The auth user count, for the counts a listing reports. */
function authUserCount(services: Record<string, unknown>): number {
  const auth = services.auth as { users?: unknown[] } | undefined;
  return Array.isArray(auth?.users) ? auth.users.length : 0;
}

/** Capture the live sandbox into a checkpoint envelope. */
export async function captureCheckpoint(sandbox: LocalSandbox): Promise<CheckpointFile> {
  const snap = sandbox.snapshot();
  const bundle = bundleRecords(serializeToBuckets(snap.firestore, snap.services, Date.now()));
  const firestoreRules = getInternalEnv(sandbox).getRules();
  const storageRules = getStorageRulesResolution(getAdminStorageSandbox(sandbox))?.source ?? null;
  const storage = await exportStorage(getAdminStorageSandbox(sandbox));
  return {
    version: 1,
    at: Date.now(),
    counts: {
      firestore: Object.keys(snap.firestore).length,
      database: databaseEntryCount(snap.services),
      storage: storage.length,
      auth: authUserCount(snap.services),
    },
    bundle,
    firestoreRules,
    storageRules,
    storage,
  };
}

/** Write one checkpoint, overwriting a prior checkpoint of the same name. */
export async function writeCheckpoint(
  sandbox: LocalSandbox,
  projectDir: string,
  name: string,
): Promise<{ overwrote: boolean; file: CheckpointFile }> {
  const path = checkpointPath(projectDir, name);
  const overwrote = existsSync(path);
  const file = await captureCheckpoint(sandbox);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file), 'utf8');
  renameSync(tmp, path);
  return { overwrote, file };
}

/** Read one checkpoint's envelope, or null when no checkpoint of that name exists. */
export function readCheckpoint(projectDir: string, name: string): CheckpointFile | null {
  const path = checkpointPath(projectDir, name);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as CheckpointFile;
}

/** The sandbox state one checkpoint file carries, for a comparison against it. */
export function checkpointSnapshot(file: CheckpointFile): SandboxSnapshot {
  return deserializeFromBuckets(parseBundle(file.bundle));
}

/** Replace the live sandbox's entire state with a checkpoint's. */
export async function applyCheckpoint(sandbox: LocalSandbox, file: CheckpointFile): Promise<void> {
  const snap = deserializeFromBuckets(parseBundle(file.bundle));
  sandbox.loadSnapshot(snap);
  setFirestoreRules(sandbox, file.firestoreRules);
  const storage = getAdminStorageSandbox(sandbox);
  for (const path of await listStoredPaths(storage)) {
    await deleteObject(storageRef(storage, path));
  }
  await restoreStorage(storage, file.storage);
  if (file.storageRules !== null) {
    try {
      await replaceStorageRules(sandbox, file.storageRules);
    } catch {
      // A checkpoint captured while storage ran without rules replays that.
    }
  }
}
