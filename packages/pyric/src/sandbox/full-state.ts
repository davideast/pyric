/**
 * The whole sandbox as one value: capture it, apply it.
 *
 * The branch engine forks from a full state and promotes onto one, and a
 * branch that silently carried only Firestore would be worse than no branch at
 * all. So this module owns the single definition of what "everything" means:
 *
 *   Firestore documents
 *   the Realtime Database tree, with its priorities
 *   Storage objects, with their bytes, content type, and custom metadata
 *   auth accounts, with the fields the auth sandbox exports, plus provider config
 *   the three rule sources: Firestore, Realtime Database, and Storage
 *
 * {@link captureFullState} is a pure read: it reaches each service's backend
 * through the same seams persistence already uses, and leaves every one of
 * those reads unchanged. {@link applyFullState} is a total replace: after it
 * returns, every read above answers exactly what the captured state holds, and
 * state the target held that the capture did not is gone.
 *
 * The value is plain JSON, so a capture survives a file, a worker message, or
 * a structured clone without losing a byte. Object bytes travel base64 encoded
 * because JSON has no byte type.
 *
 * Placement: this is cross-surface runtime, not a capability, so it lives in
 * central `sandbox/` alongside persistence and replay, which reach across the
 * same services for the same reason.
 */

import { getAuth, sandbox as authSandbox, type Auth, type SeedUser } from '../auth/index.js';
import { getOrCreateBackend } from '../database/sandbox/backend-for.js';
import type { RtdbBackend } from '../database/sandbox/backend.js';
import type { JsonValue } from '../database/sandbox/data-tree.js';
import {
  deleteObject,
  getBytes,
  getMetadata,
  listAll,
  ref,
  uploadBytes,
  type FirebaseStorage,
} from '../storage/index.js';
import {
  arrayBufferToBase64,
  base64ToBytes,
  getAdminStorageSandbox,
  getStorageRulesResolution,
  replaceStorageRules,
} from '../storage/internal.js';
import { getInternalEnv } from './internal/sandbox-impl.js';
import type { LocalSandbox } from './types/service.js';

/** A Realtime Database ruleset, in the `{ rules: ... }` envelope the SDK takes. */
export interface DatabaseRuleset {
  rules: Record<string, unknown>;
}

/** One Storage object, with everything a reader of it can observe. */
export interface StorageObjectState {
  /** Full path within the bucket, for example `docs/hello.txt`. */
  path: string;
  /** The object's bytes, base64 encoded so the state stays JSON. */
  contentBase64: string;
  /** Content type the object reports, absent when it carries none. */
  contentType?: string;
  /** The object's custom metadata. Always present, empty when it carries none. */
  customMetadata: Record<string, string>;
}

/** The auth account store: the users and the provider configuration over them. */
export interface AuthAccountsState {
  /**
   * Every account the auth sandbox exports, in the `seedUsers` shape: uid,
   * email, password, and the optional displayName, customClaims, photoUrl,
   * phoneNumber, emailVerified, disabled, tenantId, and providerId. Anonymous
   * accounts are not exported, matching what the auth sandbox persists.
   */
  users: SeedUser[];
  /** Which sign-in providers are enabled, by provider id. */
  providers: Record<string, boolean>;
}

/** The three rule sources a sandbox evaluates against. */
export interface SandboxRuleSources {
  /** Firestore Security Rules source. The empty source when none is installed. */
  firestore: string;
  /** Realtime Database rules, or null when the sandbox runs without them. */
  database: DatabaseRuleset | null;
  /** Storage Security Rules source, or null when the sandbox runs without them. */
  storage: string | null;
}

/**
 * The services a full state carries, in the order every reader walks them.
 *
 * One declaration: {@link SandboxService} is derived from it, the branch diff
 * tags each divergence with one of these names, and the branch store writes one
 * file per entry. A service added to {@link FullSandboxState} is added here, and
 * the type, the diff, and the store follow without a second list to edit.
 */
export const SANDBOX_SERVICES = ['firestore', 'database', 'storage', 'auth', 'rules'] as const;

/** One service a full state carries. */
export type SandboxService = (typeof SANDBOX_SERVICES)[number];

/** Everything one sandbox holds, as one plain JSON value. */
export interface FullSandboxState {
  /** Firestore documents by full path. */
  firestore: Record<string, Record<string, unknown>>;
  /**
   * The Realtime Database persistence envelope: the tree and its priorities.
   * The database's rules travel in {@link SandboxRuleSources} instead, so the
   * two can never disagree about which ruleset the state carries.
   */
  database: JsonValue;
  /** Every Storage object in the default bucket, ordered by path. */
  storage: StorageObjectState[];
  /** The auth account store. */
  auth: AuthAccountsState;
  /** The three rule sources. */
  rules: SandboxRuleSources;
}

/** The auth handle onto one sandbox, created on first reach the way `getAuth` does. */
function authFor(sandbox: LocalSandbox): Auth {
  return getAuth(sandbox);
}

/** The default Realtime Database backend behind one sandbox. */
function databaseBackendFor(sandbox: LocalSandbox): RtdbBackend {
  return getOrCreateBackend(sandbox);
}

/** The rules-bypass Storage handle onto one sandbox's default bucket. */
function storageFor(sandbox: LocalSandbox): FirebaseStorage {
  return getAdminStorageSandbox(sandbox);
}

/**
 * The database persistence envelope with its rules key removed. The envelope
 * the backend exports carries the active ruleset inline; the full state names
 * rules once, under `rules.database`, so a caller editing one rule source can
 * never leave a second stale copy behind in the tree.
 */
function databaseStateWithoutRules(backend: RtdbBackend): JsonValue {
  const exported = backend.exportPersistenceState();
  const isObject = exported !== null && typeof exported === 'object' && !Array.isArray(exported);
  if (!isObject) return exported;
  const envelope: Record<string, JsonValue> = { ...(exported as Record<string, JsonValue>) };
  delete envelope.rules;
  return envelope as unknown as JsonValue;
}

/** Every object path in the bucket. `listAll` reports one level, so this descends. */
async function storagePaths(storage: FirebaseStorage): Promise<string[]> {
  const paths: string[] = [];
  const pending: string[] = [''];
  while (pending.length > 0) {
    const prefix = pending.pop() as string;
    const listing = await listAll(ref(storage, prefix));
    for (const item of listing.items) paths.push(item.fullPath);
    for (const child of listing.prefixes) pending.push(child.fullPath);
  }
  paths.sort();
  return paths;
}

/** Read every Storage object out of the bucket, bytes included. */
async function captureStorage(storage: FirebaseStorage): Promise<StorageObjectState[]> {
  const objects: StorageObjectState[] = [];
  for (const path of await storagePaths(storage)) {
    const metadata = await getMetadata(ref(storage, path));
    const bytes = await getBytes(ref(storage, path));
    const object: StorageObjectState = {
      path,
      contentBase64: arrayBufferToBase64(bytes),
      customMetadata: { ...(metadata.customMetadata ?? {}) },
    };
    if (metadata.contentType !== undefined) object.contentType = metadata.contentType;
    objects.push(object);
  }
  return objects;
}

/**
 * Read one sandbox's entire state.
 *
 * A pure read: every service is reached through its own export seam, nothing
 * is written, and two captures with no intervening write are identical values.
 */
export async function captureFullState(sandbox: LocalSandbox): Promise<FullSandboxState> {
  const env = getInternalEnv(sandbox);
  const database = databaseBackendFor(sandbox);
  const auth = authFor(sandbox);
  const storage = storageFor(sandbox);

  const rules: SandboxRuleSources = {
    firestore: env.getRules(),
    database: database.getActiveRules(),
    storage: getStorageRulesResolution(storage)?.source ?? null,
  };

  return {
    firestore: structuredClone(env.snapshot()) as Record<string, Record<string, unknown>>,
    database: databaseStateWithoutRules(database),
    storage: await captureStorage(storage),
    auth: {
      users: authSandbox.exportUsers(auth),
      providers: authSandbox.exportProviderConfig(auth),
    },
    rules: structuredClone(rules),
  };
}

/** Replace the target's Firestore documents with exactly the ones the state holds. */
function applyFirestoreDocuments(
  sandbox: LocalSandbox,
  documents: Record<string, Record<string, unknown>>,
): void {
  const env = getInternalEnv(sandbox);
  for (const path of Object.keys(env.snapshot())) {
    if (path in documents) continue;
    sandbox.admin.deleteDocument(path);
  }
  for (const [path, data] of Object.entries(documents)) {
    sandbox.admin.setDocument(path, structuredClone(data));
  }
}

/** Replace the target's Realtime Database tree and install the state's ruleset. */
function applyDatabase(sandbox: LocalSandbox, state: FullSandboxState): void {
  const backend = databaseBackendFor(sandbox);
  backend.restoreTree(structuredClone(state.database));
  backend.setRules(structuredClone(state.rules.database));
}

/** Replace the target's auth account store with exactly the accounts the state holds. */
function applyAuth(sandbox: LocalSandbox, accounts: AuthAccountsState): void {
  const auth = authFor(sandbox);
  authSandbox.clearUsers(auth);
  if (accounts.users.length > 0) authSandbox.seedUsers(auth, structuredClone(accounts.users));
  authSandbox.restoreProviderConfig(auth, { ...accounts.providers });
}

/** Replace the target's bucket with exactly the objects the state holds. */
async function applyStorage(
  sandbox: LocalSandbox,
  objects: readonly StorageObjectState[],
): Promise<void> {
  const storage = storageFor(sandbox);
  for (const path of await storagePaths(storage)) {
    await deleteObject(ref(storage, path));
  }
  for (const object of objects) {
    const settable: { contentType?: string; customMetadata?: Record<string, string> } = {
      customMetadata: { ...object.customMetadata },
    };
    if (object.contentType !== undefined) settable.contentType = object.contentType;
    await uploadBytes(ref(storage, object.path), base64ToBytes(object.contentBase64), settable);
  }
}

/**
 * Whether a captured Storage ruleset is one a target can be given.
 *
 * A sandbox captured while Storage ran without rules carries null. There is no
 * source to install and no way to un-install one, so a null source means no
 * change. Both writers read this: the total replace below, and the delta a
 * branch promotion writes.
 */
export function installsStorageRules(source: string | null): source is string {
  return source !== null;
}

/** Install the Storage ruleset the state carries, where it carries one. */
async function applyStorageRules(sandbox: LocalSandbox, source: string | null): Promise<void> {
  if (!installsStorageRules(source)) return;
  await replaceStorageRules(sandbox, source);
}

/**
 * Replace one sandbox's entire state with `state`.
 *
 * A total replace, not a merge: state the target holds and the capture does
 * not is removed. After this returns, every read {@link captureFullState}
 * covers answers exactly what `state` holds.
 */
export async function applyFullState(
  sandbox: LocalSandbox,
  state: FullSandboxState,
): Promise<void> {
  applyFirestoreDocuments(sandbox, state.firestore);
  getInternalEnv(sandbox).deployRules(state.rules.firestore);
  applyDatabase(sandbox, state);
  applyAuth(sandbox, state.auth);
  await applyStorage(sandbox, state.storage);
  await applyStorageRules(sandbox, state.rules.storage);
}
