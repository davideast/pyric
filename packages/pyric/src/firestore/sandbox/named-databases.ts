/**
 * Named Firestore database identity, validation, record-space encoding, and
 * per-Sandbox LocalEnvironment isolation (ADR-0021 Decisions 1, 2, 3, and 5).
 */
import type { Sandbox } from 'pyric/sandbox';
import { SandboxError } from 'pyric/sandbox';
import {
  emitSandboxEvent,
  getClock,
  getInternalEnv,
} from '../../sandbox/internal/index.js';
import {
  sanitizeAdminListedDocuments,
  sanitizeAdminReadDocument,
} from '../../sandbox/internal/snapshot-firestore-docs.js';
import { recordedAdminDelete, recordedAdminSet } from './admin-writes.js';
import {
  getAuthLens,
  resolveAuthLensState,
} from '../../sandbox/internal/auth-lens.js';
import { pathToBucketId } from '../../sandbox/persistence/chunk-format.js';
import type {
  ListenerLifecycleEvent,
  SandboxEvent,
} from '../../sandbox/types/events.js';
import { LocalEnvironment } from './local-environment.js';

export const DEFAULT_FIRESTORE_DATABASE = '(default)' as const;
export const MAX_FIRESTORE_DATABASES = 100 as const;

const NAMED_DATABASE_ID_PATTERN = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const LOCKED_FIRESTORE_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} {',
  '      allow read, write: if false;',
  '    }',
  '  }',
  '}',
].join('\n');

let nextNamedEventSeq = 1;
function makeNamedEventId(): string {
  const seq = (nextNamedEventSeq++).toString(36);
  const rnd = Math.random().toString(36).slice(2, 7);
  return `sbe-ndb-${seq}-${rnd}`;
}

/** Normalize an optional Firestore database selector; empty or absent means `(default)`. */
export function normalizeFirestoreDatabaseId(databaseId?: string): string {
  if (
    databaseId === undefined ||
    databaseId === '' ||
    databaseId === DEFAULT_FIRESTORE_DATABASE
  ) {
    return DEFAULT_FIRESTORE_DATABASE;
  }
  return databaseId;
}

/** Validate a Firestore database id against Firebase's naming rules (plus `(default)`). */
export function isValidFirestoreDatabaseId(databaseId: string): boolean {
  if (databaseId === DEFAULT_FIRESTORE_DATABASE) return true;
  if (databaseId.length < 4 || databaseId.length > 63) return false;
  if (!NAMED_DATABASE_ID_PATTERN.test(databaseId)) return false;
  if (UUID_PATTERN.test(databaseId)) return false;
  return true;
}

/** Enforce Firebase naming rules on a declared database id and return the normalized id. */
export function assertValidFirestoreDatabaseDeclaration(databaseId: string): string {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (!isValidFirestoreDatabaseId(normalized)) {
    throw new SandboxError(
      'invalid-argument',
      `Invalid Firestore database id "${databaseId}". Database ids must be "(default)" or 4-63 lowercase letters, digits, or hyphens, starting with a letter, ending with a letter or digit, and not formatted as a UUID.`,
    );
  }
  return normalized;
}

/** Prefix under which named Firestore record spaces live for `baseKey`. */
export function firestoreRecordSpacePrefix(baseKey: string): string {
  if (baseKey.length === 0 || baseKey.includes('/firestore/')) {
    throw new SandboxError(
      'invalid-argument',
      `Invalid persistence base key "${baseKey}": base key cannot be empty or contain "/firestore/".`,
    );
  }
  return `${baseKey}/firestore/`;
}

/** Compute the persistence record-space key for `databaseId` under `baseKey`. */
export function firestoreRecordSpaceKey(baseKey: string, databaseId?: string): string {
  const prefix = firestoreRecordSpacePrefix(baseKey);
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    return baseKey;
  }
  assertValidFirestoreDatabaseDeclaration(normalized);
  return `${prefix}${normalized}`;
}

/** Parse a persistence namespace back to `'(default)'`, a valid named database id, or `null`. */
export function parseFirestoreRecordSpaceKey(
  baseKey: string,
  namespace: string,
): string | null {
  const prefix = firestoreRecordSpacePrefix(baseKey);
  if (namespace === baseKey) return DEFAULT_FIRESTORE_DATABASE;
  if (!namespace.startsWith(prefix)) return null;
  const candidate = namespace.slice(prefix.length);
  if (candidate === DEFAULT_FIRESTORE_DATABASE) return null;
  if (!isValidFirestoreDatabaseId(candidate)) return null;
  return candidate;
}

/** Production C3 NOT_FOUND message for an undeclared database on Admin / server surfaces. */
export function missingFirestoreDatabaseNotFoundMessage(
  databaseId: string,
  projectId = 'demo-project',
): string {
  return (
    `The database ${databaseId} does not exist for project ${projectId} ` +
    `Please visit https://console.cloud.google.com/datastore/setup?project=${projectId} ` +
    'to add a Cloud Datastore or Cloud Firestore database. '
  );
}

interface NamedDatabaseEntry {
  readonly id: string;
  env: LocalEnvironment;
  declared: boolean;
  lockedByDefault: boolean;
  unsubs: Array<() => void>;
  dirtyAll: boolean;
  dirtyBuckets: Set<string>;
  persistedBuckets: Set<string>;
  generation: number;
}

export interface SandboxDatabaseRegistry {
  readonly entries: Map<string, NamedDatabaseEntry>;
  readonly changeListeners: Set<() => void>;
  readonly missingNoticesLogged: Set<string>;
  lastPersistedDeclaredJson: string;
  declaredGeneration: number;
  disposed: boolean;
}

const registries = new WeakMap<Sandbox, SandboxDatabaseRegistry>();

export function peekDatabaseRegistry(sandbox: Sandbox): SandboxDatabaseRegistry | undefined {
  return registries.get(sandbox);
}

function stampDatabaseOnEvent(event: SandboxEvent, databaseId: string): SandboxEvent {
  return {
    ...(event as unknown as Record<string, unknown>),
    database: databaseId,
  } as unknown as SandboxEvent;
}

function notifyPersistenceChange(registry: SandboxDatabaseRegistry): void {
  if (registry.disposed) return;
  for (const listener of registry.changeListeners) {
    try {
      listener();
    } catch {
      // Observational persistence listeners must never disrupt sandbox mutations.
    }
  }
}

function attachNamedEnv(
  sandbox: Sandbox,
  registry: SandboxDatabaseRegistry,
  entry: NamedDatabaseEntry,
): void {
  const clock = getClock(sandbox);
  entry.unsubs.push(
    entry.env.onStateChange((path) => {
      entry.generation += 1;
      if (path === null) entry.dirtyAll = true;
      else entry.dirtyBuckets.add(pathToBucketId(path));
      notifyPersistenceChange(registry);
    }),
  );
  entry.unsubs.push(
    entry.env.onRequest((event) => emitSandboxEvent(sandbox, stampDatabaseOnEvent(event, entry.id))),
  );
  entry.unsubs.push(
    entry.env.onWrite((event) => emitSandboxEvent(sandbox, stampDatabaseOnEvent(event, entry.id))),
  );
  entry.unsubs.push(
    entry.env.onSnapshotDelivery((event) =>
      emitSandboxEvent(sandbox, stampDatabaseOnEvent(event, entry.id)),
    ),
  );
  entry.unsubs.push(
    entry.env.onSnapshotSuppressed((event) =>
      emitSandboxEvent(sandbox, stampDatabaseOnEvent(event, entry.id)),
    ),
  );
  entry.unsubs.push(
    entry.env.onListenerLifecycle((event) =>
      emitSandboxEvent(sandbox, stampDatabaseOnEvent(event, entry.id)),
    ),
  );
  entry.unsubs.push(
    entry.env.onSnapshotError((err, target, listenerId) => {
      let targetShape: ListenerLifecycleEvent['target'];
      if (target.kind === 'doc') {
        targetShape = { kind: 'doc', path: target.path };
      } else if (target.collectionGroup) {
        targetShape = { kind: 'query', collection: target.collection, collectionGroup: true };
      } else {
        targetShape = { kind: 'query', collection: target.collection };
      }
      const ev: ListenerLifecycleEvent = {
        kind: 'listener_errored',
        id: makeNamedEventId(),
        at: clock.now(),
        listenerId,
        target: targetShape,
        auth: err.request?.auth ?? null,
        error: { code: 'permission-denied', message: err.message },
      };
      emitSandboxEvent(sandbox, stampDatabaseOnEvent(ev, entry.id));
    }),
  );
}

function detachNamedEnv(entry: NamedDatabaseEntry): void {
  for (const unsub of entry.unsubs) unsub();
  entry.unsubs = [];
}

function createNamedLocalEnvironment(
  clock: ReturnType<typeof getClock>,
  normalizedId: string,
): LocalEnvironment {
  const env = new LocalEnvironment(clock);
  Object.defineProperty(env, 'databaseId', {
    value: normalizedId,
    enumerable: false,
    configurable: true,
  });
  return env;
}

function applyInitialRules(env: LocalEnvironment, lockedByDefault: boolean): void {
  if (!lockedByDefault) return;
  env.seed({ rules: LOCKED_FIRESTORE_RULES, documents: {}, explicitRules: false });
}

export function getOrCreateDatabaseRegistry(sandbox: Sandbox): SandboxDatabaseRegistry {
  getInternalEnv(sandbox);
  const existing = registries.get(sandbox);
  if (existing !== undefined) return existing;
  const registry: SandboxDatabaseRegistry = {
    entries: new Map(),
    changeListeners: new Set(),
    missingNoticesLogged: new Set(),
    lastPersistedDeclaredJson: '[]',
    declaredGeneration: 0,
    disposed: false,
  };
  registries.set(sandbox, registry);

  const unsubUser = sandbox.onCurrentUserChanged((user) => {
    const next = resolveAuthLensState(getAuthLens(), user);
    for (const entry of registry.entries.values()) {
      entry.env.reevaluateLiveListeners(next.auth, undefined, next.bypassRules);
    }
  });

  const unsubEvents = sandbox.onEvent((event) => {
    if (event.kind !== 'session_boundary') return;
    if (event.phase === 'reset') {
      const clock = getClock(sandbox);
      for (const entry of registry.entries.values()) {
        const explicitRules = entry.env.getExplicitRules();
        detachNamedEnv(entry);
        entry.env.dispose();
        entry.env = createNamedLocalEnvironment(clock, entry.id);
        if (explicitRules !== null) entry.env.deployRules(explicitRules);
        else applyInitialRules(entry.env, entry.lockedByDefault);
        attachNamedEnv(sandbox, registry, entry);
        entry.generation += 1;
        entry.dirtyAll = true;
        entry.dirtyBuckets.clear();
      }
      notifyPersistenceChange(registry);
      return;
    }
    if (event.phase === 'dispose') {
      registry.disposed = true;
      unsubUser();
      unsubEvents();
      for (const entry of registry.entries.values()) {
        detachNamedEnv(entry);
        entry.env.dispose();
      }
      registry.entries.clear();
      registry.changeListeners.clear();
    }
  });

  return registry;
}

function countDeclaredNamedDatabases(registry: SandboxDatabaseRegistry): number {
  let count = 0;
  for (const entry of registry.entries.values()) {
    if (entry.declared) count += 1;
  }
  return count;
}

function ensureNamedEntry(
  sandbox: Sandbox,
  registry: SandboxDatabaseRegistry,
  normalizedId: string,
  lockedByDefault: boolean,
): NamedDatabaseEntry {
  const existing = registry.entries.get(normalizedId);
  if (existing !== undefined) return existing;
  const env = createNamedLocalEnvironment(getClock(sandbox), normalizedId);
  applyInitialRules(env, lockedByDefault);
  const entry: NamedDatabaseEntry = {
    id: normalizedId,
    env,
    declared: false,
    lockedByDefault,
    unsubs: [],
    dirtyAll: true,
    dirtyBuckets: new Set(),
    persistedBuckets: new Set(),
    generation: 1,
  };
  attachNamedEnv(sandbox, registry, entry);
  registry.entries.set(normalizedId, entry);
  return entry;
}

export interface DeclareFirestoreDatabaseOptions {
  locked?: boolean;
}

/** Declare a Firestore database on `sandbox` under Firebase's naming rules and 100-database cap. */
export function declareFirestoreDatabase(
  sandbox: Sandbox,
  databaseId: string,
  options?: DeclareFirestoreDatabaseOptions,
): void {
  const normalized = assertValidFirestoreDatabaseDeclaration(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    getInternalEnv(sandbox);
    return;
  }
  const registry = getOrCreateDatabaseRegistry(sandbox);
  const existing = registry.entries.get(normalized);
  if (existing !== undefined && existing.declared) {
    if (options?.locked !== undefined && !existing.env.hasExplicitRules()) {
      existing.lockedByDefault = options.locked;
      applyInitialRules(existing.env, options.locked);
    }
    return;
  }
  const currentTotal = 1 + countDeclaredNamedDatabases(registry);
  if (currentTotal >= MAX_FIRESTORE_DATABASES) {
    throw new SandboxError(
      'failed-precondition',
      `Cannot declare Firestore database "${normalized}": a project supports at most ${MAX_FIRESTORE_DATABASES} databases including "(default)".`,
    );
  }
  const entry = ensureNamedEntry(sandbox, registry, normalized, options?.locked === true);
  entry.declared = true;
  if (options?.locked !== undefined && !entry.env.hasExplicitRules()) {
    entry.lockedByDefault = options.locked;
    applyInitialRules(entry.env, options.locked);
  }
  registry.declaredGeneration += 1;
  notifyPersistenceChange(registry);
}

/** Undeclare a named Firestore database in memory while leaving persisted record spaces intact. */
export function undeclareFirestoreDatabase(sandbox: Sandbox, databaseId: string): void {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    throw new SandboxError(
      'invalid-argument',
      'Cannot undeclare the "(default)" Firestore database.',
    );
  }
  const registry = getOrCreateDatabaseRegistry(sandbox);
  const entry = registry.entries.get(normalized);
  if (entry === undefined || !entry.declared) return;
  entry.declared = false;
  registry.declaredGeneration += 1;
  notifyPersistenceChange(registry);
}

/** Return true when `databaseId` is `(default)` or has been declared on `sandbox`. */
export function isFirestoreDatabaseDeclared(sandbox: Sandbox, databaseId?: string): boolean {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    getInternalEnv(sandbox);
    return true;
  }
  const existing = registries.get(sandbox);
  if (existing === undefined) {
    getInternalEnv(sandbox);
    return false;
  }
  return existing.entries.get(normalized)?.declared === true;
}

/** Sorted list of declared non-default Firestore database ids on `sandbox`. */
export function listDeclaredFirestoreDatabases(sandbox: Sandbox): string[] {
  const existing = registries.get(sandbox);
  if (existing === undefined) {
    getInternalEnv(sandbox);
    return [];
  }
  const ids: string[] = [];
  for (const [id, entry] of existing.entries) {
    if (entry.declared) ids.push(id);
  }
  ids.sort();
  return ids;
}

/** Resolve the `LocalEnvironment` for a declared `databaseId` on `sandbox` (throws `not-found` if undeclared). */
export function getDatabaseEnv(sandbox: Sandbox, databaseId?: string): LocalEnvironment {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    return getInternalEnv(sandbox);
  }
  const registry = getOrCreateDatabaseRegistry(sandbox);
  const entry = registry.entries.get(normalized);
  if (entry === undefined || !entry.declared) {
    throw new SandboxError('not-found', missingFirestoreDatabaseNotFoundMessage(normalized));
  }
  return entry.env;
}

export const getFirestoreDatabaseEnv = getDatabaseEnv;

const inertClientEnvs = new WeakMap<Sandbox, LocalEnvironment>();

/** Resolve the `LocalEnvironment` for client handle construction without implicitly declaring the database. */
export function getClientHandleEnv(sandbox: Sandbox, databaseId?: string): LocalEnvironment {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) return getInternalEnv(sandbox);
  const entry = registries.get(sandbox)?.entries.get(normalized);
  if (entry !== undefined && entry.declared) return entry.env;
  let inert = inertClientEnvs.get(sandbox);
  if (inert === undefined) {
    inert = new LocalEnvironment(getClock(sandbox));
    inertClientEnvs.set(sandbox, inert);
  }
  return inert;
}

/**
 * Resolve a deferred `LocalEnvironment` for Admin handle construction so
 * reference creation (`doc`, `collection`, `batch`) succeeds synchronously while
 * actual operations throw C3 `not-found` until `databaseId` is declared,
 * without retaining per-string state for undeclared database ids.
 */
export function getAdminHandleEnv(sandbox: Sandbox, databaseId?: string): LocalEnvironment {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) return getInternalEnv(sandbox);
  const entry = registries.get(sandbox)?.entries.get(normalized);
  if (entry !== undefined && entry.declared) return entry.env;
  const inert = getClientHandleEnv(sandbox, normalized);
  return new Proxy(inert, {
    get(target, prop) {
      if (prop === 'databaseId') return normalized;
      const declaredNow = registries.get(sandbox)?.entries.get(normalized);
      if (declaredNow !== undefined && declaredNow.declared) {
        const val = Reflect.get(declaredNow.env, prop, declaredNow.env);
        if (typeof val === 'function') {
          return (val as (...args: unknown[]) => unknown).bind(declaredNow.env);
        }
        return val;
      }
      const fallback = Reflect.get(target, prop, target);
      if (typeof fallback === 'function') {
        return (...args: unknown[]) => {
          const live = getDatabaseEnv(sandbox, normalized);
          const fn = Reflect.get(live, prop, live) as (...a: unknown[]) => unknown;
          return fn.apply(live, args);
        };
      }
      return fallback;
    },
  });
}

/** Log a one-time upgrade / missing-database notice per `(sandbox, databaseId)`. */
export function logMissingFirestoreDatabaseNoticeOnce(
  sandbox: Sandbox,
  databaseId: string,
  requestedPath?: string,
): void {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) return;
  const registry = getOrCreateDatabaseRegistry(sandbox);
  if (registry.missingNoticesLogged.has(normalized)) return;
  if (registry.missingNoticesLogged.size < 256) {
    registry.missingNoticesLogged.add(normalized);
  }
  let trail = '';
  if (typeof requestedPath === 'string' && requestedPath.length > 0) {
    if (getInternalEnv(sandbox).getDocument(requestedPath) !== null) {
      trail = ` Note: "(default)" holds a document at "${requestedPath}".`;
    }
  }
  console.warn(
    `[pyric/firestore] Database "${normalized}" is not declared. Add { "database": "${normalized}", "rules": "firestore.rules" } to the "firestore" array in firebase.json (or call declareFirestoreDatabase).${trail}`,
  );
}

/** Resolve a rules-bypassing `SandboxAdmin` surface for `databaseId` (throws C3 `not-found` if undeclared). */
export function getDatabaseAdmin(
  sandbox: Sandbox,
  databaseId?: string,
  projectId = 'demo-project',
): Sandbox['admin'] {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    getInternalEnv(sandbox);
    return sandbox.admin;
  }
  const registry = getOrCreateDatabaseRegistry(sandbox);
  const entry = registry.entries.get(normalized);
  if (entry === undefined || !entry.declared) {
    throw new SandboxError(
      'not-found',
      missingFirestoreDatabaseNotFoundMessage(normalized, projectId),
    );
  }
  return {
    getDocument: (path: string) => sanitizeAdminReadDocument(entry.env.getDocument(path)),
    listDocuments: (prefix: string) => sanitizeAdminListedDocuments(entry.env.listDocuments(prefix)),
    setDocument: (path: string, data: Record<string, unknown>) =>
      recordedAdminSet(entry.env, path, data),
    deleteDocument: (path: string) => recordedAdminDelete(entry.env, path),
  };
}

/** Subscribe to named-database document or declaration changes on `sandbox`. */
export function onNamedFirestorePersistenceChange(
  sandbox: Sandbox,
  listener: () => void,
): () => void {
  const registry = getOrCreateDatabaseRegistry(sandbox);
  registry.changeListeners.add(listener);
  return () => {
    registry.changeListeners.delete(listener);
  };
}
