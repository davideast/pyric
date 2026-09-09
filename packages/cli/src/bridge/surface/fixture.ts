/**
 * Portable, committable fixtures: `exportFixture` writes one, `seedFromFixture`
 * loads one back on top of live state.
 *
 * A fixture is the same shape `sandbox.seed` already accepts (`SandboxSeed`),
 * which is also the shape the evaluation harness seeds a task with. Loading a
 * fixture goes through the same two functions `seed` calls, `applyRules` and
 * `applyData`, so there is one code path for "apply this state to a sandbox"
 * rather than a second loader beside the one `seed` already has.
 *
 * This is a different envelope from `pyric snapshot`'s `PyricStateFile`
 * (`packages/cli/src/cli/snapshot.ts`), which stores Firestore's own
 * persistence-controller blob rather than plain JSON documents. Unifying the
 * two fixture formats is a tracked design item, not done here; `seedFromFixture`
 * reads the shape `exportFixture` writes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { getInternalEnv } from 'pyric/sandbox/internal';
import { getActiveRules as getDatabaseRules } from 'pyric/sandbox/database';
import { snapshotDocuments } from 'pyric/sandbox/firestore';
import { getAdminDatabase, get as databaseGet, ref as databaseRef } from 'pyric/database';
import { getAdminStorageSandbox, getStorageRulesResolution } from 'pyric/storage/internal';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import type { LocalSandbox } from 'pyric/sandbox';
import { exportStorage } from '../server/storage-sidecar.js';
import {
  applyData,
  applyRules,
  type SandboxSeed,
  type SeedStorageEntry,
  type SeedUserEntry,
} from './seed-apply.js';

/** Build a fixture from the live sandbox's current state. */
export async function buildFixture(sandbox: LocalSandbox): Promise<SandboxSeed> {
  const firestore = snapshotDocuments(sandbox);
  const database = (await databaseGet(databaseRef(getAdminDatabase(sandbox)))).val() as
    | Record<string, unknown>
    | null;
  const storage = await exportStorage(getAdminStorageSandbox(sandbox));
  const users: SeedUserEntry[] = authSandbox.exportUsers(getAuth(sandbox)).map((user) => {
    const record: SeedUserEntry = { uid: user.uid };
    if (user.email !== undefined) record.email = user.email;
    if (user.customClaims !== undefined) record.customClaims = user.customClaims;
    if (user.tenantId !== undefined) record.tenantId = user.tenantId;
    return record;
  });

  const storageEntries: SeedStorageEntry[] = storage.map((object) => {
    const entry: SeedStorageEntry = { path: object.path, contentBase64: object.contentBase64 };
    if (object.contentType !== undefined) entry.contentType = object.contentType;
    const custom = customMetadataOf(object.metadata);
    if (custom !== null) entry.customMetadata = custom;
    return entry;
  });

  const fixture: SandboxSeed = {
    firestoreRules: getInternalEnv(sandbox).getRules(),
    users,
    firestore,
    storage: storageEntries,
  };
  if (database !== null && database !== undefined) fixture.database = database;
  const databaseRules = getDatabaseRules(sandbox);
  if (databaseRules !== null) fixture.databaseRules = JSON.stringify(databaseRules);
  const storageRules = getStorageRulesResolution(getAdminStorageSandbox(sandbox))?.source;
  if (storageRules !== undefined) fixture.storageRules = storageRules;
  return fixture;
}

/** Storage custom metadata is a string map; a value of another type is not one. */
function customMetadataOf(metadata: Record<string, unknown>): Record<string, string> | null {
  const entries: Record<string, string> = {};
  let found = false;
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') continue;
    entries[key] = value;
    found = true;
  }
  if (!found) return null;
  return entries;
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

/** Load a fixture's state onto the live sandbox, on top of whatever is already there. */
export async function applyFixture(sandbox: LocalSandbox, fixture: SandboxSeed): Promise<void> {
  await applyRules(sandbox, fixture);
  await applyData(sandbox, fixture);
}
