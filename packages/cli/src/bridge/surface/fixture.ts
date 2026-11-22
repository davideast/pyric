/**
 * Portable, committable fixtures: `exportFixture` writes one, `seedFromFixture`
 * loads one back on top of live state.
 *
 * A fixture is the same shape `sandbox.seed` already accepts (`SandboxSeed`),
 * which is also the shape the evaluation harness seeds a task with. Exporting a
 * fixture captures a canonical `SandboxSnapshot` (preserving Firestore SDK
 * value types, RTDB priorities, Storage metadata, and Auth user records), and
 * loading a fixture applies rules and merges data onto the live sandbox via
 * `applyRules` and `applyData`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LocalSandbox } from 'pyric/sandbox';
import { captureNamedFirestoreState } from 'pyric/firestore/internal';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
} from 'pyric/sandbox/internal';
import {
  FIXTURE_EXPORT_DOCUMENT,
  copyStorageObjectHeaders,
} from './storage-state.js';
import {
  applyData,
  applyRules,
  type SandboxSeed,
  type SandboxSeedDatabase,
  type SeedStorageEntry,
  type SeedUserEntry,
} from './seed-apply.js';
import {
  formatWrongFileError,
  identifyPyricFile,
  STATE_FIXTURE_KEYS,
  STATE_FIXTURE_SCHEMA,
} from '../../verify/file-format.js';

export type SandboxStateFixture = SandboxSeed & {
  schema?: typeof STATE_FIXTURE_SCHEMA;
};

/** Build a fixture from the live sandbox's current state. */
export async function buildFixture(
  sandbox: LocalSandbox,
  excludePasswords = false,
): Promise<SandboxStateFixture> {
  const snapshot = await captureSandboxSnapshot(sandbox, {
    excludePasswords,
    inlineStorageDocument: FIXTURE_EXPORT_DOCUMENT,
  });

  const users: SeedUserEntry[] = snapshot.auth.users.map((user) => {
    const record: SeedUserEntry = { uid: user.uid };
    if (user.email !== undefined) record.email = user.email;
    if (user.displayName !== undefined) record.displayName = user.displayName;
    if (user.photoUrl !== undefined) record.photoUrl = user.photoUrl;
    if (user.phoneNumber !== undefined) record.phoneNumber = user.phoneNumber;
    if (user.providerId !== undefined) record.providerId = user.providerId;
    if (user.emailVerified !== undefined) record.emailVerified = user.emailVerified;
    if (user.disabled !== undefined) record.disabled = user.disabled;
    if (user.customClaims !== undefined) {
      record.customClaims = structuredClone(user.customClaims) as Record<string, unknown>;
    }
    if (user.tenantId !== undefined) record.tenantId = user.tenantId;
    if (user.createdAt !== undefined) record.createdAt = user.createdAt;
    if (user.lastLoginAt !== undefined) record.lastLoginAt = user.lastLoginAt;
    if (!excludePasswords && user.password !== undefined) record.password = user.password;
    return record;
  });

  const defaultStorage = snapshot.storage[DEFAULT_SNAPSHOT_RESOURCE] ?? [];
  const storageEntries: SeedStorageEntry[] = defaultStorage.map((object) => {
    const entry: SeedStorageEntry = {
      path: object.path,
      contentBase64: object.contentBase64,
    };
    copyStorageObjectHeaders(object, entry);
    if (object.customMetadata !== undefined) {
      entry.customMetadata = { ...object.customMetadata };
    }
    return entry;
  });

  const firestoreDocs: Record<string, Record<string, unknown>> = {};
  const capturedDocs = snapshot.firestore[DEFAULT_SNAPSHOT_RESOURCE] ?? {};
  for (const [path, encodedDoc] of Object.entries(capturedDocs)) {
    firestoreDocs[path] = { ...encodedDoc };
  }

  const fixture: SandboxStateFixture = {
    schema: STATE_FIXTURE_SCHEMA,
    users,
    firestore: firestoreDocs,
    storage: storageEntries,
  };

  const firestoreRules = snapshot.rules.firestore?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (firestoreRules !== undefined) fixture.firestoreRules = firestoreRules;

  const namedFirestore = captureNamedFirestoreState(sandbox);
  if (namedFirestore.declared.length > 0) {
    fixture.firestoreDeclared = namedFirestore.declared;
    const namedDocs: Record<string, Record<string, Record<string, unknown>>> = {};
    for (const [dbId, docs] of Object.entries(namedFirestore.databases)) {
      const clonedDocs: Record<string, Record<string, unknown>> = {};
      for (const [docPath, encodedDoc] of Object.entries(docs)) {
        clonedDocs[docPath] = { ...encodedDoc };
      }
      namedDocs[dbId] = clonedDocs;
    }
    fixture.firestoreDatabases = namedDocs;
    if (Object.keys(namedFirestore.rules).length > 0) {
      fixture.firestoreDatabaseRules = { ...namedFirestore.rules };
    }
  }

  const defaultDatabase = snapshot.rtdb[DEFAULT_SNAPSHOT_RESOURCE];
  if (defaultDatabase !== null && defaultDatabase !== undefined) {
    fixture.database = defaultDatabase as SandboxSeedDatabase;
  }
  const databaseRules = snapshot.rules.rtdb?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (databaseRules !== undefined) fixture.databaseRules = databaseRules;
  const storageRules = snapshot.rules.storage?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (storageRules !== undefined) fixture.storageRules = storageRules;
  return fixture;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate a versioned or legacy unversioned sandbox state fixture. */
function parseStateFixture(value: unknown): SandboxStateFixture {
  if (!isPlainObject(value)) {
    throw new Error(formatWrongFileError('state-fixture', value, 'Invalid sandbox state fixture'));
  }
  const detected = identifyPyricFile(value);
  if (detected !== null && detected.kind !== 'state-fixture') {
    throw new Error(formatWrongFileError('state-fixture', value));
  }
  if (value.schema !== undefined && value.schema !== STATE_FIXTURE_SCHEMA) {
    throw new Error(
      formatWrongFileError('state-fixture', value, `Unsupported fixture schema '${String(value.schema)}'`),
    );
  }
  for (const key of Object.keys(value)) {
    if (key === 'schema' || STATE_FIXTURE_KEYS.has(key)) continue;
    throw new Error(
      formatWrongFileError('state-fixture', value, `Invalid sandbox state fixture: unexpected field '${key}'`),
    );
  }
  if (value.firestore !== undefined && !isPlainObject(value.firestore)) {
    throw new Error(
      formatWrongFileError('state-fixture', value, 'Invalid sandbox state fixture: firestore must be an object'),
    );
  }
  if (value.firestoreDatabases !== undefined && !isPlainObject(value.firestoreDatabases)) {
    throw new Error(
      formatWrongFileError('state-fixture', value, 'Invalid sandbox state fixture: firestoreDatabases must be an object'),
    );
  }
  if (value.firestoreDeclared !== undefined && !Array.isArray(value.firestoreDeclared)) {
    throw new Error(
      formatWrongFileError('state-fixture', value, 'Invalid sandbox state fixture: firestoreDeclared must be an array'),
    );
  }
  if (value.firestoreDatabaseRules !== undefined && !isPlainObject(value.firestoreDatabaseRules)) {
    throw new Error(
      formatWrongFileError('state-fixture', value, 'Invalid sandbox state fixture: firestoreDatabaseRules must be an object'),
    );
  }
  if (value.users !== undefined && !Array.isArray(value.users)) {
    throw new Error(
      formatWrongFileError('state-fixture', value, 'Invalid sandbox state fixture: users must be an array'),
    );
  }
  if (value.storage !== undefined && !Array.isArray(value.storage)) {
    throw new Error(
      formatWrongFileError('state-fixture', value, 'Invalid sandbox state fixture: storage must be an array'),
    );
  }
  for (const rulesKey of ['firestoreRules', 'databaseRules', 'storageRules'] as const) {
    if (value[rulesKey] !== undefined && typeof value[rulesKey] !== 'string') {
      throw new Error(
        formatWrongFileError('state-fixture', value, `Invalid sandbox state fixture: ${rulesKey} must be a string`),
      );
    }
  }
  return value as SandboxStateFixture;
}

/** Write a fixture to `path`, creating its parent directory. */
export function writeFixtureFile(path: string, fixture: SandboxStateFixture): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
}

/** Read a fixture file back into a `SandboxStateFixture`, or null when it does not exist. */
export function readFixtureFile(path: string): SandboxStateFixture | null {
  if (!existsSync(path)) return null;
  return parseStateFixture(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Load a fixture's state onto the live sandbox, on top of whatever is already
 * there. Returns why each rules source production would not load was refused.
 */
export async function applyFixture(sandbox: LocalSandbox, fixture: SandboxStateFixture): Promise<string[]> {
  const refusals = await applyRules(sandbox, fixture);
  await applyData(sandbox, fixture);
  return refusals;
}
