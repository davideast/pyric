/**
 * Apply a typed seed to a sandbox, merging onto its live state via the
 * canonical `SandboxSnapshot` restoration pipeline.
 *
 * This is the one implementation of "what a seed does to a sandbox." The eval
 * harness seeds a fresh sandbox with it before a run starts, `sandbox.seed`
 * calls the same two functions against the live sandbox, and `applyFixture`
 * restores `ValueCodec`-tagged or plain JSON `SandboxSeed` documents through
 * the same path.
 *
 * Ordering matters. The database default policy is stateful and every write
 * is evaluated against whatever ruleset is in force, so rules are applied
 * before any data write.
 */
import { parseRtdbRulesText } from '../../rtdb/rules-json.js';
import { loadDatabaseRules } from './database-rules-load.js';
import type { LocalSandbox } from 'pyric/sandbox';
import {
  DEFAULT_SNAPSHOT_RESOURCE,
  decodeBase64ToBytes,
  restoreSandboxSnapshot,
  type SandboxSnapshot,
  type SnapshotStorageObject,
  type SnapshotUserRecord,
} from 'pyric/sandbox/internal';
import { getAdminStorageSandbox, replaceStorageRules } from 'pyric/storage/internal';
import { getAuth, sandbox as authSandbox, type SeedUser } from 'pyric/auth';
import { loadFirestoreRules } from './firestore-rules-load.js';
import { rememberUnloadedStorageRules } from './storage-rules.js';
import {
  copyStorageObjectHeaders,
  type OptionalStorageObjectHeaders,
} from './storage-state.js';

/** One seeded user, as a plain data record rather than a validated Zod shape. */
export interface SeedUserEntry {
  uid: string;
  email?: string;
  displayName?: string;
  photoUrl?: string;
  phoneNumber?: string;
  providerId?: string;
  emailVerified?: boolean;
  disabled?: boolean;
  customClaims?: Record<string, unknown>;
  tenantId?: string;
  createdAt?: string;
  lastLoginAt?: string | null;
  /**
   * Password credential to seed. `exportFixture` carries it unless the call
   * passed `excludePasswords`, so a fixture round trip preserves sign-in by
   * default, while passwordless or custom-token accounts stay passwordless.
   */
  password?: string;
}

/** One seeded storage object. */
export interface SeedStorageEntry extends OptionalStorageObjectHeaders {
  path: string;
  contentBase64: string;
  customMetadata?: Record<string, string>;
}

/** Valid non-null JSON values accepted at the RTDB root of a `SandboxSeed`. */
export type SandboxSeedDatabase =
  | Record<string, unknown>
  | unknown[]
  | string
  | number
  | boolean;

/** State to load into a sandbox. The harness's `EvalSeed` is an alias of this. */
export interface SandboxSeed {
  firestoreRules?: string;
  databaseRules?: string;
  storageRules?: string;
  users?: SeedUserEntry[];
  /** Document path to document data. */
  firestore?: Record<string, Record<string, unknown>>;
  /** Realtime Database tree or root value written at `/`. */
  database?: SandboxSeedDatabase;
  storage?: SeedStorageEntry[];
}

function normalizeSeedUser(user: SeedUserEntry): SnapshotUserRecord {
  const record: {
    uid: string;
    email?: string;
    password?: string;
    displayName?: string;
    photoUrl?: string;
    phoneNumber?: string;
    providerId?: string;
    emailVerified?: boolean;
    disabled?: boolean;
    customClaims?: Record<string, unknown>;
    tenantId?: string;
    createdAt?: string;
    lastLoginAt?: string | null;
  } = {
    uid: user.uid,
  };
  if (user.email !== undefined) record.email = user.email;
  if (user.password !== undefined) record.password = user.password;
  if (user.providerId !== undefined) record.providerId = user.providerId;
  if (user.displayName !== undefined) record.displayName = user.displayName;
  if (user.photoUrl !== undefined) record.photoUrl = user.photoUrl;
  if (user.phoneNumber !== undefined) record.phoneNumber = user.phoneNumber;
  if (user.emailVerified !== undefined) record.emailVerified = user.emailVerified;
  if (user.disabled !== undefined) record.disabled = user.disabled;
  if (user.customClaims !== undefined) {
    record.customClaims = { ...user.customClaims };
  }
  if (user.tenantId !== undefined) record.tenantId = user.tenantId;
  if (user.createdAt !== undefined) record.createdAt = user.createdAt;
  if (user.lastLoginAt !== undefined) record.lastLoginAt = user.lastLoginAt;
  return record;
}

/**
 * Write user records into the auth pool. `seedUsers` is the only entry point
 * that carries a tenant onto a stored record, so every seeded identity goes
 * through it, and `auth.importUsers` reaches the pool through this same
 * function rather than a second import path of its own.
 */
export function applyUsers(sandbox: LocalSandbox, users: readonly SeedUserEntry[]): void {
  if (users.length === 0) return;
  const auth = getAuth(sandbox);
  authSandbox.seedUsers(
    auth,
    users.map((user): SeedUser => {
      const normalized = normalizeSeedUser(user);
      const record: SeedUser = { uid: normalized.uid };
      if (normalized.email !== undefined) record.email = normalized.email;
      if (normalized.password !== undefined) record.password = normalized.password;
      if (normalized.displayName !== undefined) record.displayName = normalized.displayName;
      if (normalized.photoUrl !== undefined) record.photoUrl = normalized.photoUrl;
      if (normalized.phoneNumber !== undefined) record.phoneNumber = normalized.phoneNumber;
      if (normalized.providerId !== undefined) record.providerId = normalized.providerId;
      if (normalized.emailVerified !== undefined) {
        record.emailVerified = normalized.emailVerified;
      }
      if (normalized.disabled !== undefined) {
        record.disabled = normalized.disabled;
      }
      if (normalized.customClaims !== undefined) {
        record.customClaims = { ...normalized.customClaims };
      }
      if (normalized.tenantId !== undefined) {
        record.tenantId = normalized.tenantId;
      }
      if (normalized.createdAt !== undefined) {
        record.createdAt = normalized.createdAt;
      }
      if (normalized.lastLoginAt !== undefined) {
        record.lastLoginAt = normalized.lastLoginAt;
      }
      return record;
    }),
  );
}

/**
 * Install the rules a seed carries, before any data write. Returns why each
 * Firestore, Storage or Realtime Database source production would not load
 * was refused.
 *
 * A seed may carry such rules on purpose, for lint tasks, so a refusal does
 * not throw: the sandbox keeps the rules in force, and lint reads the refused
 * source (Firestore and Storage simulate read it too).
 */
export async function applyRules(sandbox: LocalSandbox, seed: SandboxSeed): Promise<string[]> {
  const refusals: string[] = [];
  const storageRules = seed.storageRules;
  if (storageRules !== undefined) {
    try {
      await replaceStorageRules(sandbox, storageRules);
    } catch (error) {
      getAdminStorageSandbox(sandbox);
      rememberUnloadedStorageRules(sandbox, storageRules);
      if (error instanceof Error) {
        refusals.push(error.message);
      } else {
        refusals.push(String(error));
      }
    }
  }
  const databaseRules = seed.databaseRules;
  if (databaseRules !== undefined) {
    const parsed = parseRtdbRulesText(databaseRules, (reason) => reason);
    const refused = loadDatabaseRules(sandbox, parsed);
    if (refused !== null) refusals.push(refused);
  }
  const firestoreRules = seed.firestoreRules;
  if (firestoreRules !== undefined) {
    const refused = loadFirestoreRules(sandbox, firestoreRules);
    if (refused !== null) refusals.push(refused);
  }
  return refusals;
}

/** Load the data a seed carries: users, documents, database tree, storage objects. */
export async function applyData(sandbox: LocalSandbox, seed: SandboxSeed): Promise<void> {
  const users = (seed.users ?? []).map(normalizeSeedUser);
  const rtdb: Record<string, unknown> = {};
  if (seed.database !== undefined && seed.database !== null) {
    rtdb[DEFAULT_SNAPSHOT_RESOURCE] = seed.database;
  }
  const storage: Record<string, readonly SnapshotStorageObject[]> = {};
  const rawObjects = seed.storage ?? [];
  if (rawObjects.length > 0) {
    storage[DEFAULT_SNAPSHOT_RESOURCE] = rawObjects.map((object) => {
      const bytes = decodeBase64ToBytes(object.contentBase64);
      const entry: OptionalStorageObjectHeaders & {
        path: string;
        contentBase64: string;
        size: number;
        customMetadata?: Record<string, string>;
      } = {
        path: object.path,
        contentBase64: object.contentBase64,
        size: bytes.byteLength,
      };
      copyStorageObjectHeaders(object, entry);
      if (object.customMetadata !== undefined) {
        entry.customMetadata = { ...object.customMetadata };
      }
      return entry;
    });
  }
  const snapshot: SandboxSnapshot = {
    version: 1,
    rules: {},
    auth: { users },
    firestore: { [DEFAULT_SNAPSHOT_RESOURCE]: seed.firestore ?? {} },
    rtdb,
    storage,
  };
  await restoreSandboxSnapshot(sandbox, snapshot, { merge: true });
}
