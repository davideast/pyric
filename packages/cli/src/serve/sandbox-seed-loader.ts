import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { bundleRecords, type PersistenceBackend } from 'pyric/sandbox';
import { createSandboxRoot } from 'pyric/sandbox/internal';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { getDatabase } from 'pyric/database';
import { getStorageSandbox } from 'pyric/storage';
import { getStorageService, targetOf, type StorageStateRecord } from 'pyric/storage/internal';
import { applyData, applyRules, type SandboxSeed } from '../bridge/surface/seed-apply.js';
import { listStoredPaths } from '../bridge/surface/storage-state.js';
import type { HostedPersistence } from './hosted/persistence.js';
import { parseStateFile, STATE_FILE_VERSION, type PyricStateFile } from './state-file.js';
import { inlineStorage } from './state-objects.js';
import type { StateStore } from './state-store.js';
import { restoredStateCounts, stateForSummary } from './state-summary.js';

function formatSandboxSeedMessage(kind: 'read' | 'shape', path: string, detail: string): string {
  if (kind === 'read') return `failed to read seed ${path}: ${detail}`;
  return `seed must be a JSON object (${detail})`;
}

export class SandboxSeedError extends Error {
  constructor(
    readonly kind: 'read' | 'shape',
    readonly path: string,
    readonly detail: string,
  ) {
    super(formatSandboxSeedMessage(kind, path, detail));
    this.name = 'SandboxSeedError';
  }
}

const SANDBOX_SEED_KEYS: ReadonlySet<string> = new Set([
  'firestore',
  'database',
  'users',
  'storage',
  'firestoreRules',
  'databaseRules',
  'storageRules',
]);

function isPlainSeedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeedableDatabaseValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return true;
  return isPlainSeedRecord(value);
}

function isSandboxSeedEnvelope(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record);
  return !('version' in record) && keys.length > 0 && keys.every((key) => SANDBOX_SEED_KEYS.has(key));
}

function validateSandboxSeedEnvelope(record: Record<string, unknown>, seedPath: string): SandboxSeed {
  if ('firestore' in record && record.firestore !== undefined) {
    if (!isPlainSeedRecord(record.firestore)) {
      throw new SandboxSeedError('shape', seedPath, 'seed.firestore must be a JSON object');
    }
    for (const [docPath, rawDoc] of Object.entries(record.firestore)) {
      if (!isPlainSeedRecord(rawDoc)) {
        throw new SandboxSeedError('shape', seedPath, `seed.firestore["${docPath}"] must be a JSON object`);
      }
    }
  }
  if ('database' in record && record.database !== undefined && !isSeedableDatabaseValue(record.database)) {
    throw new SandboxSeedError('shape', seedPath, 'seed.database must be a non-null JSON value');
  }
  if ('users' in record && record.users !== undefined && !Array.isArray(record.users)) {
    throw new SandboxSeedError('shape', seedPath, 'seed.users must be an array');
  }
  if ('storage' in record && record.storage !== undefined && !Array.isArray(record.storage)) {
    throw new SandboxSeedError('shape', seedPath, 'seed.storage must be an array');
  }
  for (const rulesKey of ['firestoreRules', 'databaseRules', 'storageRules'] as const) {
    if (rulesKey in record && record[rulesKey] !== undefined && typeof record[rulesKey] !== 'string') {
      throw new SandboxSeedError('shape', seedPath, `seed.${rulesKey} must be a string`);
    }
  }
  return record as SandboxSeed;
}

async function materializeSandboxSeedState(seedRecord: SandboxSeed): Promise<PyricStateFile> {
  const memoryRecords = new Map<string, unknown>();
  const backend: PersistenceBackend = {
    async getRecord(_key, recordId) {
      return memoryRecords.get(recordId) ?? null;
    },
    async listRecords(_key) {
      return [...memoryRecords.keys()];
    },
    async putRecords(_key, records) {
      for (const [recordId, value] of records) memoryRecords.set(recordId, value);
    },
    async deleteRecords(_key, recordIds) {
      for (const recordId of recordIds) memoryRecords.delete(recordId);
    },
    async clear(_key) {
      memoryRecords.clear();
    },
  };
  const tempSandbox = createSandboxRoot();
  try {
    await tempSandbox.enablePersistence({ key: 'seed-materialize', injectedBackend: backend });
    const auth = getAuth(tempSandbox);
    getDatabase(tempSandbox);
    await applyRules(tempSandbox, seedRecord);
    await applyData(tempSandbox, seedRecord);
    await tempSandbox.flush();
    const exportedUsers = authSandbox.exportUsers(auth);
    let storageEntries: StorageStateRecord[] | undefined;
    if (seedRecord.storage && seedRecord.storage.length > 0) {
      const storage = getStorageSandbox(tempSandbox);
      const storageBackend = (await getStorageService(storage)).backend;
      const { bucket } = targetOf(storage);
      const paths = await listStoredPaths(storage);
      const collected: StorageStateRecord[] = [];
      for (const objectPath of paths) {
        const stored = await storageBackend.getObject(objectPath, bucket);
        if (stored === undefined) continue;
        collected.push({
          dataBase64: Buffer.from(await stored.blob.arrayBuffer()).toString('base64'),
          blobType: stored.blob.type,
          metadata: stored.metadata,
        });
      }
      if (collected.length > 0) storageEntries = collected;
    }
    let firestoreSection: unknown = null;
    if (memoryRecords.size > 0) {
      firestoreSection = JSON.parse(bundleRecords(memoryRecords));
    }
    const authSection = exportedUsers.length > 0 ? { users: exportedUsers } : null;
    const stateFile: PyricStateFile = {
      version: STATE_FILE_VERSION,
      firestore: firestoreSection,
      auth: authSection,
    };
    if (storageEntries !== undefined) {
      stateFile.storage = storageEntries;
    }
    return stateFile;
  } finally {
    tempSandbox.dispose();
  }
}

export interface LoadedSessionSeed {
  persisted: ReturnType<typeof stateForSummary>;
  seed: Record<string, Record<string, unknown>> | null;
  seedState: unknown | null;
  seedUsers: Record<string, unknown>[] | null;
  seedLabel: string | null;
  seedApplied: boolean;
}

export async function loadSandboxSeedOption(params: {
  projectDir: string;
  seedFile: string | undefined;
  state: StateStore | undefined;
  hostedPersistence: HostedPersistence | undefined;
  hosted: boolean;
}): Promise<LoadedSessionSeed> {
  let persisted = stateForSummary(params.state, { hosted: params.hosted });
  let seed: Record<string, Record<string, unknown>> | null = null;
  let seedState: unknown | null = null;
  let seedUsers: Record<string, unknown>[] | null = null;
  let seedLabel: string | null = null;
  let seedApplied = false;

  const { seedFile, state, hostedPersistence } = params;
  const hasStateStore = state !== undefined;
  if (!seedFile) {
    return { persisted, seed, seedState, seedUsers, seedLabel, seedApplied };
  }

  // A snapshot directory holds its document as state.json, with objects/ beside it.
  const seedTarget = resolve(params.projectDir, seedFile);
  const seedsDirectory = existsSync(seedTarget) && statSync(seedTarget).isDirectory();
  let seedPath = seedTarget;
  if (seedsDirectory) {
    seedPath = join(seedTarget, 'state.json');
  }
  const objectsFrom = dirname(seedPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(seedPath, 'utf8')) as unknown;
  } catch (error) {
    let message: string;
    if (error instanceof Error) {
      message = error.message;
    } else {
      message = String(error);
    }
    throw new SandboxSeedError('read', seedPath, message);
  }
  const isArray = Array.isArray(parsed);
  const isNotObject = !parsed || typeof parsed !== 'object';
  if (isNotObject || isArray) {
    const kind = isArray ? 'array' : typeof parsed;
    throw new SandboxSeedError('shape', seedPath, `got ${kind}`);
  }

  const record = parsed as Record<string, unknown>;
  const hasStateVersion = 'version' in record;
  const hasStateSections = 'firestore' in record || 'auth' in record || 'storage' in record;
  if (hasStateVersion && hasStateSections) {
    const fixture = parseStateFile(record, seedPath);
    const { restoredDocs, restoredUsers } = restoredStateCounts(fixture);
    seedLabel = `${restoredDocs} doc(s) + ${restoredUsers} user(s) from state fixture`;
    if (hasStateStore && !state.exists()) {
      if (hostedPersistence !== undefined) {
        await hostedPersistence.seed(fixture, objectsFrom);
      } else {
        let storage: ReturnType<typeof inlineStorage> | undefined;
        if (fixture.storage !== undefined) {
          storage = inlineStorage(fixture.storage, objectsFrom);
        }
        if (fixture.firestore != null) await state.writeSection('firestore', fixture.firestore);
        if (fixture.auth != null) await state.writeSection('auth', fixture.auth);
        if (storage !== undefined) await state.writeSection('storage', storage);
      }
      seedApplied = true;
      persisted = stateForSummary(state, { hosted: params.hosted });
    } else if (!hasStateStore) {
      seedState = fixture.firestore ?? null;
      if (fixture.auth) {
        seedUsers = fixture.auth.users.map((user) => ({ ...user }));
      } else {
        seedUsers = null;
      }
    }
    return { persisted, seed, seedState, seedUsers, seedLabel, seedApplied };
  }

  if (isSandboxSeedEnvelope(record)) {
    const seedRecord = validateSandboxSeedEnvelope(record, seedPath);
    let docCount = 0;
    if (seedRecord.firestore) {
      docCount = Object.keys(seedRecord.firestore).length;
    }
    const userCount = seedRecord.users?.length ?? 0;
    const hasRtdb = seedRecord.database !== undefined;
    const userPart = userCount > 0 ? ` + ${userCount} user(s)` : '';
    const rtdbPart = hasRtdb ? ' + database' : '';
    seedLabel = `${docCount} doc(s)${userPart}${rtdbPart} from seed envelope`;
    if (hasStateStore && !state.exists()) {
      const fixture = await materializeSandboxSeedState(seedRecord);
      if (hostedPersistence !== undefined) {
        await hostedPersistence.seed(fixture, objectsFrom);
      } else {
        if (fixture.firestore != null) await state.writeSection('firestore', fixture.firestore);
        if (fixture.auth != null) await state.writeSection('auth', fixture.auth);
        if (fixture.storage !== undefined) await state.writeSection('storage', fixture.storage);
      }
      seedApplied = true;
      persisted = stateForSummary(state, { hosted: params.hosted });
    } else if (!hasStateStore) {
      seed = record as Record<string, Record<string, unknown>>;
      if (Array.isArray(seedRecord.users)) {
        seedUsers = seedRecord.users.map((user) => ({ ...(user as unknown as Record<string, unknown>) }));
      } else {
        seedUsers = null;
      }
    }
    return { persisted, seed, seedState, seedUsers, seedLabel, seedApplied };
  }

  seed = record as Record<string, Record<string, unknown>>;
  seedLabel = `${Object.keys(seed).length} document(s)`;
  return { persisted, seed, seedState, seedUsers, seedLabel, seedApplied };
}
