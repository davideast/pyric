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
 *   Messaging broker state: tokens, tombstones, and topic subscriptions
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
import { resetCrashlyticsBroker } from '../crashlytics/internal.js';
import { getMessagingBroker } from '../messaging/internal.js';
import { isMessagingSnapshot, type MessagingSnapshot } from '../messaging/broker/persistence.js';
import { SandboxImpl, getInternalEnv } from './internal/sandbox-impl.js';
import { authAccountsFor } from 'pyric/sandbox/internal';
import type { AuthAccountHistory } from './internal/auth-accounts.js';
import { databaseInstanceNamed } from './internal/instances.js';
import {
  databaseEnvelopeWithRules,
  extractDatabaseInstances,
  isEmptyRtdbTree,
  stripDatabaseRules,
  type DatabaseRuleset,
} from './internal/rtdb-envelope.js';
import {
  applyStorageObjects,
  applyStorageRulesState,
  captureStorageObjects,
  captureStorageRulesState,
  holdsBytesInline,
  inlineStorageBytes,
  type StorageObjectState,
} from './internal/storage-full-state.js';
import { encodeStateDocument, decodeStateDocument } from './internal/state-values.js';
import { getClock, type SandboxClockState } from './clock.js';
import type { LocalSandbox } from './types/service.js';

export type { DatabaseRuleset, MessagingSnapshot, StorageObjectState };
export { holdsBytesInline, inlineStorageBytes };

/** How a capture records Storage bytes. */
export interface FullStateCaptureOptions {
  /** `inline` (the default) carries every object's bytes; `reference` names them by hash. */
  storage?: 'inline' | 'reference';
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
  /** Storage Security Rules source for the unnamed default bucket, or null when none is installed. */
  storage: string | null;
  /** Per-bucket Storage Security Rules sources by bucket name; omitted when none are deployed. */
  storageBuckets?: Record<string, string>;
  /** Undeployed Storage bucket policy when per-bucket rules mode is active; omitted otherwise. */
  storageUndeployedPolicy?: 'allow' | 'deny';
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
export const SANDBOX_SERVICES = ['firestore', 'database', 'storage', 'auth', 'rules', 'messaging'] as const;

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
  /** Every Storage object across the default and named buckets, ordered by bucket and path. */
  storage: StorageObjectState[];
  /** The auth account store. */
  auth: AuthAccountsState;
  /** The three rule sources. */
  rules: SandboxRuleSources;
  /**
   * Durable Messaging broker state: active tokens, unregistered tombstones, and
   * topic subscriptions. Optional: omitted when empty or in states captured
   * before Messaging was included.
   */
  messaging?: MessagingSnapshot;
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

/** The auth account store: accounts, provider config, and the revocations and deletions over them. */
function captureAuth(sandbox: LocalSandbox, auth: Auth): AuthAccountsState {
  const users = structuredClone(authSandbox.exportUsers(auth));
  const providers = { ...authSandbox.exportProviderConfig(auth) };
  const history = authAccountsFor(sandbox)?.history();
  return history === undefined ? { users, providers } : { users, providers, history: structuredClone(history) };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeMessagingSnapshot(raw: unknown): MessagingSnapshot | undefined {
  if (!isMessagingSnapshot(raw)) return undefined;
  const tokens = raw.tokens
    .map(([token, record]): [string, typeof record] => [token, { ...record }])
    .sort((left, right) => compareText(left[0], right[0]));
  const topics: Array<[string, string[]]> = [];
  for (const [topic, members] of raw.topics) {
    const unique = [...new Set(members)].sort(compareText);
    if (unique.length > 0) topics.push([topic, unique]);
  }
  topics.sort((left, right) => compareText(left[0], right[0]));
  if (tokens.length === 0 && topics.length === 0) return undefined;
  return { version: 1, tokens, topics };
}

/** Pure read of the sandbox's durable Messaging state, if any tokens or topics exist. */
export function captureMessaging(sandbox: LocalSandbox): MessagingSnapshot | undefined {
  if (!(sandbox instanceof SandboxImpl)) return undefined;
  const registered = sandbox.getServiceRegistry().get('messaging');
  if (registered !== undefined) return normalizeMessagingSnapshot(registered.snapshot());
  const pending = sandbox.getPendingSnapshotServices().get('messaging');
  if (pending !== undefined) return normalizeMessagingSnapshot(pending);
  return undefined;
}

/** Replace or clear the sandbox's Messaging broker state without leaving stale tokens or topics behind. */
export function applyMessaging(sandbox: LocalSandbox, captured: MessagingSnapshot | undefined): void {
  const normalized = normalizeMessagingSnapshot(captured);
  if (normalized === undefined) {
    if (!(sandbox instanceof SandboxImpl)) return;
    const registered = sandbox.getServiceRegistry().get('messaging');
    if (registered !== undefined) {
      registered.reset?.();
      return;
    }
    if (sandbox.getPendingSnapshotServices().has('messaging')) {
      getMessagingBroker(sandbox).reset();
    }
    return;
  }
  const broker = getMessagingBroker(sandbox);
  broker.reset();
  broker.restore(structuredClone(normalized));
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

  const secondaryDatabaseData: Record<string, JsonValue> = {};
  const secondaryDatabaseRules: Record<string, DatabaseRuleset | null> = {};
  for (const name of heldDatabaseInstances(sandbox)) {
    const instBackend = getOrCreateBackend(sandbox, databaseInstanceNamed(name));
    const instEnvelope = stripDatabaseRules(instBackend.exportPersistenceState());
    const instRules = instBackend.getActiveRules();
    const isEnvelopeObj =
      instEnvelope !== null && typeof instEnvelope === 'object' && !Array.isArray(instEnvelope);
    let hasData: boolean;
    if (isEnvelopeObj) {
      const record = instEnvelope as Record<string, JsonValue>;
      const rawPriorities = (record.priorities ?? {}) as Record<string, unknown>;
      hasData = !isEmptyRtdbTree(record.data) || Object.keys(rawPriorities).length > 0;
    } else {
      hasData = !isEmptyRtdbTree(instEnvelope);
    }
    if (hasData) secondaryDatabaseData[name] = instEnvelope;
    if (instRules !== null) secondaryDatabaseRules[name] = instRules;
  }

  let defaultDatabase = stripDatabaseRules(database.exportPersistenceState());
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

  const storageRules = captureStorageRulesState(sandbox);
  const rules: SandboxRuleSources = {
    firestore: env.getExplicitRules() ?? '',
    database: database.getActiveRules(),
    storage: storageRules.storage,
  };
  if (Object.keys(secondaryDatabaseRules).length > 0) {
    rules.databaseInstances = secondaryDatabaseRules;
  }
  if (storageRules.storageBuckets !== undefined) {
    rules.storageBuckets = storageRules.storageBuckets;
  }
  if (storageRules.storageUndeployedPolicy !== undefined) {
    rules.storageUndeployedPolicy = storageRules.storageUndeployedPolicy;
  }
  if (storageRules.storageCrossServiceIam !== undefined) {
    rules.storageCrossServiceIam = storageRules.storageCrossServiceIam;
  }

  const messaging = captureMessaging(sandbox);
  const fullState: FullSandboxState = {
    firestore: Object.fromEntries(Object.entries(env.snapshot()).map(([path, data]) => [path, encodeStateDocument(data)])),
    firestoreEncoding: DOC_VALUE_ENCODING,
    database: defaultDatabase,
    storage: await captureStorageObjects(sandbox, options.storage ?? 'inline'),
    auth: captureAuth(sandbox, auth),
    rules: structuredClone(rules),
    clock: getClock(sandbox).capture(),
  };
  if (messaging !== undefined) fullState.messaging = messaging;
  return fullState;
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
  if (accounts.history !== undefined) {
    table?.replayHistory(structuredClone(accounts.history));
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
  const env = getInternalEnv(sandbox);
  if (state.rules.firestore.length > 0) {
    env.deployRules(state.rules.firestore);
  } else {
    env.resetToDefaultRules();
  }
  applyDatabase(sandbox, state);
  applyAuth(sandbox, state.auth);
  applyMessaging(sandbox, state.messaging);
  resetCrashlyticsBroker(sandbox);
  await applyStorageObjects(sandbox, state.storage);
  await applyStorageRulesState(sandbox, state.rules);
}
