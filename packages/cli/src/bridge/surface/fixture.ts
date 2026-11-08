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
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  captureSandboxSnapshot,
} from 'pyric/sandbox/internal';
import { FIXTURE_EXPORT_DOCUMENT } from './storage-state.js';
import {
  applyData,
  applyRules,
  type SandboxSeed,
  type SeedStorageEntry,
  type SeedUserEntry,
} from './seed-apply.js';

/** Build a fixture from the live sandbox's current state. */
export async function buildFixture(
  sandbox: LocalSandbox,
  excludePasswords = false,
): Promise<SandboxSeed> {
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
    if (object.contentType !== undefined) entry.contentType = object.contentType;
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

  const fixture: SandboxSeed = {
    firestoreRules: snapshot.rules.firestore?.[DEFAULT_SNAPSHOT_RESOURCE] ?? '',
    users,
    firestore: firestoreDocs,
    storage: storageEntries,
  };

  const defaultDatabase = snapshot.rtdb[DEFAULT_SNAPSHOT_RESOURCE];
  if (
    defaultDatabase !== null &&
    defaultDatabase !== undefined &&
    typeof defaultDatabase === 'object' &&
    !Array.isArray(defaultDatabase)
  ) {
    fixture.database = defaultDatabase as Record<string, unknown>;
  }
  const databaseRules = snapshot.rules.rtdb?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (databaseRules !== undefined) fixture.databaseRules = databaseRules;
  const storageRules = snapshot.rules.storage?.[DEFAULT_SNAPSHOT_RESOURCE];
  if (storageRules !== undefined) fixture.storageRules = storageRules;
  return fixture;
}

/** Write a fixture to `path`, creating its parent directory. */
export function writeFixtureFile(path: string, fixture: SandboxSeed): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
}

/** Read a fixture file back into a `SandboxSeed`, or null when it does not exist. */
export function readFixtureFile(path: string): SandboxSeed | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as SandboxSeed;
}

/**
 * Load a fixture's state onto the live sandbox, on top of whatever is already
 * there. Returns why each rules source production would not load was refused.
 */
export async function applyFixture(sandbox: LocalSandbox, fixture: SandboxSeed): Promise<string[]> {
  const refusals = await applyRules(sandbox, fixture);
  await applyData(sandbox, fixture);
  return refusals;
}
