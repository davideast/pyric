/**
 * The whole sandbox as one value: capture it, apply it.
 *
 * The branch engine forks from a full state and promotes onto one, and a
 * branch that silently carried only Firestore would be worse than no branch at
 * all. So this module owns the single definition of what "everything" means:
 *
 *   Firestore documents
 *   the Realtime Database tree, with its priorities
 *   Storage objects, with their bytes and complete stored metadata
 *   auth accounts, with the fields the auth sandbox exports, plus provider config
 *     and each account's revocation time and the deleted uids
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
import { getOrCreateBackend, heldDatabaseInstances } from '../database/sandbox/backend-for.js';
import type { RtdbBackend } from '../database/sandbox/backend.js';
import type { JsonValue } from '../database/sandbox/data-tree.js';
import { DOC_VALUE_ENCODING, type DocValueEncoding } from '../firestore/internal/value-codec.js';
import {
  ref,
  uploadBytes,
  type FirebaseStorage,
} from '../storage/index.js';
import {
  DEFAULT_BUCKET,
  base64ToBytes,
  getAdminStorageSandbox,
  getStorageCrossServiceIam,
  getStorageRulesResolution,
  getStorageService,
  pruneStorageBucketRules,
  replaceCrossServiceIam,
  replaceStorageRules,
  referenceStorageState,
  resetStorageState,
  restoreStorageReferences,
  restoreStorageState,
  snapshotStorageState,
  type StorageStateRecord,
} from '../storage/internal.js';
import { getInternalEnv } from './internal/sandbox-impl.js';
import { authAccountsFor } from 'pyric/sandbox/internal';
import type { AuthAccountHistory } from './internal/auth-accounts.js';
import { assertInlineStorageFits, base64DecodedLength, type InlineStorageDocument } from './internal/inline-storage-limit.js';
import { databaseInstanceNamed } from './internal/instances.js';
import { readStorageCaches } from './internal/snapshot-codec.js';
import { encodeStateDocument, decodeStateDocument } from './internal/state-values.js';
import { getClock, type SandboxClockState } from './clock.js';
import type { LocalSandbox } from './types/service.js';

/** A Realtime Database ruleset, in the `{ rules: ... }` envelope the SDK takes. */
export interface DatabaseRuleset {
  rules: Record<string, unknown>;
}

/**
 * One Storage object, with everything a reader of it can observe. Its bytes are
 * either inline as base64, or named by SHA-256 in the backend that holds them:
 * a capture by reference writes the second form, and only a backend that keeps
 * content-addressed files can apply it.
 */
export type StorageObjectState = StorageObjectFields & (
  | {
    /** The object's bytes, base64 encoded so the state stays JSON. */
    contentBase64: string;
  }
  | {
    /** The SHA-256 of the object's bytes, which the backend holds. */
    sha256: string;
    /** The number of bytes. */
    size: number;
  }
);

/** Whether a Storage entry carries its bytes inline. */
export function holdsBytesInline(object: StorageObjectState): object is StorageObjectState & { contentBase64: string } {
  return 'contentBase64' in object;
}

/** How a capture records Storage bytes. */
export interface FullStateCaptureOptions {
  /** `inline` (the default) carries every object's bytes; `reference` names them by hash. */
  storage?: 'inline' | 'reference';
}

interface StorageObjectFields {
  /** Full path within the bucket, for example `docs/hello.txt`. */
  path: string;
  /** Content type the object reports, absent when it carries none. */
  contentType?: string;
  /** The object's custom metadata. Always present, empty when it carries none. */
  customMetadata: Record<string, string>;
  /** Remaining persisted metadata; absent in legacy states that only kept upload fields. */
  metadata?: Omit<StorageStateRecord['metadata'], 'fullPath' | 'contentType' | 'customMetadata'>;
  /** The stored Blob's MIME type, which can differ from its object metadata. */
  blobType?: string;
}

/** The auth account store: the users and the provider configuration over them. */
export interface AuthAccountsState {
  /**
   * Every account the auth sandbox exports, in the `seedUsers` shape: uid,
   * email, password, and the optional displayName, customClaims, photoUrl,
   * phoneNumber, emailVerified, disabled, tenantId, providerId and account
   * timestamps. Anonymous accounts are included in the same export contract.
   */
  users: SeedUser[];
  /** Which sign-in providers are enabled, by provider id. */
  providers: Record<string, boolean>;
  /**
   * Each account's refresh-token revocation time and the uids whose record
   * was deleted. Production keeps both on the account, so restoring the
   * state does not bring a revoked or deleted session back (#2021).
   *
   * Optional: a state written before it restores with every revocation and
   * deletion forgotten, as it always did.
   */
  history?: AuthAccountHistory;
}

/** The three rule sources a sandbox evaluates against. */
export interface SandboxRuleSources {
  /** Firestore Security Rules source. The empty source when none is installed. */
  firestore: string;
  /** Realtime Database rules, or null when the sandbox runs without them. */
  database: DatabaseRuleset | null;
  /** Secondary Realtime Database rulesets by instance name; omitted when none are installed. */
  databaseInstances?: Record<string, DatabaseRuleset | null>;
  /** Storage Security Rules source, or null when the sandbox runs without them. */
  storage: string | null;
  /** Cross-service IAM posture for Storage `firestore.get()` / `firestore.exists()`; omitted when `'granted'`. */
  storageCrossServiceIam?: 'granted' | 'denied';
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
  /** Declared value encoding; absent in legacy states that carry plain document maps. */
  firestoreEncoding?: DocValueEncoding;
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
  /**
   * The sandbox clock's state at capture. A checkpoint restore and a branch
   * fork both carry it, so a forked branch reaches the same `request.time`
   * verdict its base reached and a restored checkpoint stamps the same
   * `serverTimestamp()` the sandbox was stamping when it was taken.
   *
   * Optional: a state written before the clock existed, or by a producer that
   * does not model time, restores the sandbox to the wall clock.
   */
  clock?: SandboxClockState;
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

/** Where an inline capture's Storage ends up, and what to use past its limit. */
export const INLINE_CAPTURE_DOCUMENT: InlineStorageDocument = {
  document: 'An inline state capture, which forks, branch files, and in-process checkpoints are written from,',
  instead: 'Branches carry their Storage bytes inline in every sandbox, so delete or shrink objects until the total ' +
    'fits before forking. On the Node host (`pyric sandbox --hosted`), checkpoints and `pyric snapshot` refer to ' +
    'object bytes by hash and are not bound by this limit.',
};

/** The object bytes a set of Storage entries carries inline, counted without decoding them. */
export function inlineStorageBytes(objects: readonly StorageObjectState[]): number {
  let total = 0;
  for (const object of objects) {
    if (holdsBytesInline(object)) total += base64DecodedLength(object.contentBase64);
  }
  return total;
}

/** Refuse an inline capture whose listed objects exceed the inline limit, before reading their bytes. */
async function assertInlineCaptureFits(storage: FirebaseStorage): Promise<void> {
  const service = await getStorageService(storage);
  let total = 0;
  for (const listed of await service.backend.listByPrefix('')) total += listed.size;
  assertInlineStorageFits(total, INLINE_CAPTURE_DOCUMENT);
}

/** Read every Storage object out of the bucket, with its bytes or with its hash. */
async function captureStorage(storage: FirebaseStorage, mode: 'inline' | 'reference'): Promise<StorageObjectState[]> {
  const byReference = mode === 'reference';
  if (byReference) return captureStorageReferences(storage);
  await assertInlineCaptureFits(storage);
  const objects: StorageObjectState[] = [];
  const records = await snapshotStorageState(storage);
  records.sort((left, right) => {
    const sortsBefore = left.metadata.fullPath < right.metadata.fullPath;
    if (sortsBefore) return -1;
    const sortsAfter = left.metadata.fullPath > right.metadata.fullPath;
    return sortsAfter ? 1 : 0;
  });
  for (const record of records) {
    const { fullPath, contentType, customMetadata, ...metadata } = record.metadata;
    const object: StorageObjectState = {
      path: fullPath,
      contentBase64: record.dataBase64,
      customMetadata: customMetadata !== undefined ? { ...customMetadata } : {},
      metadata: structuredClone(metadata),
      blobType: record.blobType,
    };
    const hasContentType = contentType !== undefined;
    if (hasContentType) object.contentType = contentType;
    objects.push(object);
  }
  // An overwrite after the listing can grow an object, so the bytes read are counted too.
  assertInlineStorageFits(inlineStorageBytes(objects), INLINE_CAPTURE_DOCUMENT);
  return objects;
}

/** Read every Storage object as a reference to the bytes its backend holds. */
async function captureStorageReferences(storage: FirebaseStorage): Promise<StorageObjectState[]> {
  const records = await referenceStorageState(storage);
  records.sort((left, right) => (left.metadata.fullPath < right.metadata.fullPath ? -1 : left.metadata.fullPath > right.metadata.fullPath ? 1 : 0));
  return records.map((record): StorageObjectState => {
    const { fullPath, contentType, customMetadata, ...metadata } = record.metadata;
    const object: StorageObjectState = {
      path: fullPath,
      sha256: record.sha256,
      size: record.size,
      customMetadata: customMetadata !== undefined ? { ...customMetadata } : {},
      metadata: structuredClone(metadata),
      blobType: record.blobType,
    };
    const hasContentType = contentType !== undefined;
    if (hasContentType) object.contentType = contentType;
    return object;
  });
}

/** The auth account store: accounts, provider config, and the revocations and deletions over them. */
function captureAuth(sandbox: LocalSandbox, auth: Auth): AuthAccountsState {
  const users = structuredClone(authSandbox.exportUsers(auth));
  const providers = { ...authSandbox.exportProviderConfig(auth) };
  const history = authAccountsFor(sandbox)?.history();
  return history === undefined ? { users, providers } : { users, providers, history: structuredClone(history) };
}

function isEmptyRtdbTree(data: JsonValue | undefined): boolean {
  if (data === null || data === undefined) return true;
  if (typeof data === 'object' && !Array.isArray(data)) {
    return Object.keys(data).length === 0;
  }
  return false;
}

/**
 * Read one sandbox's entire state.
 *
 * A pure read: every service is reached through its own export seam, nothing
 * is written, and two captures with no intervening write are identical values.
 */
export async function captureFullState(sandbox: LocalSandbox, options: FullStateCaptureOptions = {}): Promise<FullSandboxState> {
  const env = getInternalEnv(sandbox);
  const database = databaseBackendFor(sandbox);
  const auth = authFor(sandbox);
  const storage = storageFor(sandbox);

  const secondaryDatabaseData: Record<string, JsonValue> = {};
  const secondaryDatabaseRules: Record<string, DatabaseRuleset | null> = {};
  for (const name of heldDatabaseInstances(sandbox)) {
    const instBackend = getOrCreateBackend(sandbox, databaseInstanceNamed(name));
    const instEnvelope = databaseStateWithoutRules(instBackend);
    const instRules = instBackend.getActiveRules();
    const isEnvelopeObj =
      instEnvelope !== null && typeof instEnvelope === 'object' && !Array.isArray(instEnvelope);
    const hasData = isEnvelopeObj
      ? !isEmptyRtdbTree((instEnvelope as Record<string, JsonValue>).data) ||
        Object.keys(((instEnvelope as Record<string, JsonValue>).priorities ?? {}) as Record<string, unknown>).length > 0
      : !isEmptyRtdbTree(instEnvelope);
    if (hasData) secondaryDatabaseData[name] = instEnvelope;
    if (instRules !== null) secondaryDatabaseRules[name] = instRules;
  }

  let defaultDatabase = databaseStateWithoutRules(database);
  if (
    Object.keys(secondaryDatabaseData).length > 0 &&
    defaultDatabase !== null &&
    typeof defaultDatabase === 'object' &&
    !Array.isArray(defaultDatabase)
  ) {
    defaultDatabase = {
      ...(defaultDatabase as Record<string, JsonValue>),
      instances: secondaryDatabaseData,
    } as unknown as JsonValue;
  }

  const crossServiceIam = getStorageCrossServiceIam(sandbox);
  const rules: SandboxRuleSources = {
    firestore: env.getRules(),
    database: database.getActiveRules(),
    ...(Object.keys(secondaryDatabaseRules).length > 0
      ? { databaseInstances: secondaryDatabaseRules }
      : {}),
    storage: getStorageRulesResolution(storage)?.source ?? null,
    ...(crossServiceIam === 'denied' ? { storageCrossServiceIam: 'denied' } : {}),
  };

  return {
    firestore: Object.fromEntries(Object.entries(env.snapshot()).map(([path, data]) => [path, encodeStateDocument(data)])),
    firestoreEncoding: DOC_VALUE_ENCODING,
    database: defaultDatabase,
    storage: await captureStorage(storage, options.storage ?? 'inline'),
    auth: captureAuth(sandbox, auth),
    rules: structuredClone(rules),
    clock: getClock(sandbox).capture(),
  };
}

/**
 * Adopt the captured clock, or return the sandbox to the wall clock when the
 * state carries none. A total replace, like every other service here: applying
 * a state never leaves the target on a clock the state did not name.
 */
function applyClock(sandbox: LocalSandbox, captured: SandboxClockState | undefined): void {
  const clock = getClock(sandbox);
  if (captured === undefined) {
    clock.reset();
    return;
  }
  clock.restore(captured);
}

/** Replace the target's Firestore documents with exactly the ones the state holds. */
function applyFirestoreDocuments(
  sandbox: LocalSandbox,
  documents: Record<string, Record<string, unknown>>,
  encoding: DocValueEncoding | undefined,
): void {
  const env = getInternalEnv(sandbox);
  for (const path of Object.keys(env.snapshot())) {
    const isRetained = path in documents;
    if (isRetained) continue;
    env.adminDeleteDocument(path);
  }
  for (const [path, data] of Object.entries(documents)) {
    env.adminSetDocument(path, decodeStateDocument(data, encoding));
  }
}

/** Build a persistence envelope carrying both the target RTDB tree and its ruleset for atomic restore. */
function databaseEnvelopeWithRules(
  database: FullSandboxState['database'],
  rules: DatabaseRuleset | null,
): JsonValue {
  const clonedDb = structuredClone(database);
  const clonedRules = structuredClone(rules) as JsonValue;
  if (
    clonedDb !== null
    && typeof clonedDb === 'object'
    && !Array.isArray(clonedDb)
    && (clonedDb as Record<string, JsonValue>)['.pyricRtdbPersistence'] === 1
    && 'data' in clonedDb
    && typeof (clonedDb as Record<string, JsonValue>).priorities === 'object'
    && (clonedDb as Record<string, JsonValue>).priorities !== null
    && !Array.isArray((clonedDb as Record<string, JsonValue>).priorities)
  ) {
    const rest: Record<string, JsonValue> = { ...(clonedDb as Record<string, JsonValue>) };
    delete rest.instances;
    return { ...rest, rules: clonedRules };
  }
  return {
    '.pyricRtdbPersistence': 1,
    data: clonedDb,
    priorities: {},
    rules: clonedRules,
  };
}

function extractDatabaseInstances(database: FullSandboxState['database']): Record<string, JsonValue> {
  if (database === null || typeof database !== 'object' || Array.isArray(database)) return {};
  const record = database as Record<string, JsonValue>;
  if (record['.pyricRtdbPersistence'] !== 1) return {};
  const rawInstances = record.instances;
  if (rawInstances === null || typeof rawInstances !== 'object' || Array.isArray(rawInstances)) return {};
  return rawInstances as Record<string, JsonValue>;
}

/** Replace the target's Realtime Database trees and install each instance's ruleset atomically before fan-out. */
function applyDatabase(sandbox: LocalSandbox, state: FullSandboxState): void {
  const backend = databaseBackendFor(sandbox);
  backend.restoreTree(databaseEnvelopeWithRules(state.database, state.rules.database));
  backend.setRules(structuredClone(state.rules.database));

  const capturedInstances = extractDatabaseInstances(state.database);
  const capturedRules = state.rules.databaseInstances ?? {};
  const allNames = new Set([...Object.keys(capturedInstances), ...Object.keys(capturedRules)]);
  const emptyEnvelope: JsonValue = { '.pyricRtdbPersistence': 1, data: null, priorities: {} };

  for (const existingName of heldDatabaseInstances(sandbox)) {
    if (allNames.has(existingName)) continue;
    const existingBackend = getOrCreateBackend(sandbox, databaseInstanceNamed(existingName));
    existingBackend.restoreTree(databaseEnvelopeWithRules(emptyEnvelope, null));
    existingBackend.setRules(null);
    existingBackend.markDormant();
  }

  for (const name of allNames) {
    const instBackend = getOrCreateBackend(sandbox, databaseInstanceNamed(name));
    const instDb = capturedInstances[name] ?? emptyEnvelope;
    const instRules = capturedRules[name] ?? null;
    instBackend.restoreTree(databaseEnvelopeWithRules(instDb, instRules));
    instBackend.setRules(structuredClone(instRules));
  }
}

/**
 * Replace the target's auth account store with exactly the accounts the state
 * holds. Clearing records a deletion for each account, and a restore is not a
 * deletion, so that history is replaced by the state's own: its revocations
 * and deletions are replayed, and a held session they refuse stays refused
 * (#2021). A state without history forgets it, as before.
 */
function applyAuth(sandbox: LocalSandbox, accounts: AuthAccountsState): void {
  const auth = authFor(sandbox);
  authSandbox.clearUsers(auth);
  const table = authAccountsFor(sandbox);
  table?.forgetHistory();
  if (accounts.users.length > 0) authSandbox.seedUsers(auth, structuredClone(accounts.users));
  authSandbox.restoreProviderConfig(auth, { ...accounts.providers });
  const carriesHistory = accounts.history !== undefined;
  if (carriesHistory) table?.replayHistory(structuredClone(accounts.history!));
}

/** Replace the target's bucket with exactly the objects the state holds, wiping any non-default buckets. */
async function applyStorage(
  sandbox: LocalSandbox,
  objects: readonly StorageObjectState[],
): Promise<void> {
  const caches = readStorageCaches();
  for (const scopedKey of caches?.scopedServices.get(sandbox)?.keys() ?? []) {
    if (scopedKey === DEFAULT_BUCKET) continue;
    await resetStorageState(getAdminStorageSandbox(sandbox, { bucket: scopedKey }));
  }
  const storage = storageFor(sandbox);
  await resetStorageState(storage);
  for (const object of objects) {
    const metadata = object.metadata;
    const referenced = !holdsBytesInline(object);
    if (referenced) {
      const missingMetadata = metadata === undefined;
      if (missingMetadata) throw new Error(`Storage object '${object.path}' is a reference without its metadata.`);
      await restoreStorageReferences(storage, [{
        sha256: object.sha256,
        size: object.size,
        blobType: object.blobType ?? object.contentType ?? '',
        metadata: { ...metadata, fullPath: object.path, contentType: object.contentType,
          customMetadata: { ...object.customMetadata } },
      }]);
      continue;
    }
    const hasStoredMetadata = metadata !== undefined;
    if (hasStoredMetadata) {
      await restoreStorageState(storage, [{
        dataBase64: object.contentBase64,
        blobType: object.blobType ?? object.contentType ?? '',
        metadata: { ...metadata, fullPath: object.path, contentType: object.contentType,
          customMetadata: { ...object.customMetadata } },
      }]);
      continue;
    }
    const settable: { contentType?: string; customMetadata?: Record<string, string> } = {
      customMetadata: { ...object.customMetadata },
    };
    const hasContentType = object.contentType !== undefined;
    if (hasContentType) settable.contentType = object.contentType;
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

/** Install the Storage ruleset and cross-service IAM posture the state carries. */
async function applyStorageRules(
  sandbox: LocalSandbox,
  source: string | null,
  crossServiceIam: 'granted' | 'denied' | undefined,
): Promise<void> {
  pruneStorageBucketRules(sandbox, new Set());
  await replaceStorageRules(sandbox, source);
  const nextCrossServiceIam = crossServiceIam ?? 'granted';
  if (nextCrossServiceIam !== getStorageCrossServiceIam(sandbox)) {
    await replaceCrossServiceIam(sandbox, nextCrossServiceIam);
  }
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
  applyClock(sandbox, state.clock);
  applyFirestoreDocuments(sandbox, state.firestore, state.firestoreEncoding);
  getInternalEnv(sandbox).deployRules(state.rules.firestore);
  applyDatabase(sandbox, state);
  applyAuth(sandbox, state.auth);
  await applyStorage(sandbox, state.storage);
  await applyStorageRules(sandbox, state.rules.storage, state.rules.storageCrossServiceIam);
}
