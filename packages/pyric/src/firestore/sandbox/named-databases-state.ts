/**
 * Lossless JSON snapshot capture and restoration for named Firestore databases.
 *
 * Used by seeds, state fixtures, worker state transfer, checkpoints, and
 * branches so every named database's declaration, rules source, and documents
 * travel alongside `(default)` without mutating `(default)`-only payloads.
 */
import type { Sandbox } from 'pyric/sandbox';
import { rulesSourceRejection } from 'pyric/rules/internal';
import { getInternalEnv } from '../../sandbox/internal/index.js';
import {
  decodeSnapshotMapForEnv,
  encodeSnapshotMap,
  type EncodedMap,
} from '../../sandbox/internal/snapshot-value-codec.js';
import {
  assertValidFirestoreDatabaseDeclaration,
  DEFAULT_FIRESTORE_DATABASE,
  declareFirestoreDatabase,
  getDatabaseEnv,
  listDeclaredFirestoreDatabases,
  LOCKED_FIRESTORE_RULES,
  missingFirestoreDatabaseNotFoundMessage,
  normalizeFirestoreDatabaseId,
  peekDatabaseRegistry,
  undeclareFirestoreDatabase,
} from './named-databases.js';
import { SandboxError } from 'pyric/sandbox';
import { markAllNamedFirestoreDirty } from './named-databases-persistence.js';

export interface NamedFirestoreCapturedState {
  readonly declared: string[];
  readonly databases: Record<string, Record<string, EncodedMap>>;
  readonly rules: Record<string, string>;
  readonly locked?: string[];
  readonly documentCount: number;
}

export interface RestoreNamedFirestoreOptions {
  readonly merge?: boolean;
}

function setOwnProperty<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function normalizeDocPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

/** Return true when a declared named database defaults to locked rules when no explicit rules are deployed. */
export function isFirestoreDatabaseLockedByDefault(
  sandbox: Sandbox,
  databaseId?: string,
): boolean {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) return false;
  const entry = peekDatabaseRegistry(sandbox)?.entries.get(normalized);
  if (entry === undefined || !entry.declared) return false;
  return entry.lockedByDefault;
}

/** Reset `databaseId`'s rules to its default policy (locked when `lockedByDefault`, open otherwise) without clearing documents. */
export function resetFirestoreDatabaseToDefaultPolicy(
  sandbox: Sandbox,
  databaseId?: string,
): void {
  const normalized = normalizeFirestoreDatabaseId(databaseId);
  if (normalized === DEFAULT_FIRESTORE_DATABASE) {
    getInternalEnv(sandbox).resetToDefaultRules();
    return;
  }
  const entry = peekDatabaseRegistry(sandbox)?.entries.get(normalized);
  if (entry === undefined || !entry.declared) {
    throw new SandboxError('not-found', missingFirestoreDatabaseNotFoundMessage(normalized));
  }
  if (!entry.lockedByDefault) {
    entry.env.resetToDefaultRules();
    return;
  }
  const existingDocs = entry.env.snapshot();
  entry.env.deployRules(LOCKED_FIRESTORE_RULES);
  entry.env.seed({ rules: LOCKED_FIRESTORE_RULES, documents: existingDocs, explicitRules: false });
}

/** Capture every declared named Firestore database's rules and encoded documents. */
export function captureNamedFirestoreState(sandbox: Sandbox): NamedFirestoreCapturedState {
  const declared = listDeclaredFirestoreDatabases(sandbox);
  const databases: Record<string, Record<string, EncodedMap>> = {};
  const rules: Record<string, string> = {};
  const locked: string[] = [];
  let documentCount = 0;

  for (const dbId of declared) {
    const env = getDatabaseEnv(sandbox, dbId);
    const rawDocs = env.snapshot();
    const encodedDocs: Record<string, EncodedMap> = {};
    const sortedPaths = Object.keys(rawDocs).sort();
    documentCount += sortedPaths.length;
    for (const path of sortedPaths) {
      const docData = rawDocs[path];
      if (docData !== undefined) {
        setOwnProperty(encodedDocs, path, encodeSnapshotMap(docData));
      }
    }
    setOwnProperty(databases, dbId, encodedDocs);
    const explicitRules = env.getExplicitRules();
    if (explicitRules !== null && explicitRules.length > 0) {
      setOwnProperty(rules, dbId, explicitRules);
    }
    if (isFirestoreDatabaseLockedByDefault(sandbox, dbId)) {
      locked.push(dbId);
    }
  }

  const captured: NamedFirestoreCapturedState = {
    declared,
    databases,
    rules,
    documentCount,
  };
  if (locked.length > 0) {
    return { ...captured, locked };
  }
  return captured;
}

/** Restore named Firestore declarations, rules, and documents onto `sandbox`. */
export function restoreNamedFirestoreState(
  sandbox: Sandbox,
  state:
    | {
        readonly declared?: readonly string[];
        readonly databases?: Readonly<Record<string, Readonly<Record<string, EncodedMap>>>>;
        readonly rules?: Readonly<Record<string, string>>;
        readonly locked?: readonly string[];
      }
    | undefined,
  options?: RestoreNamedFirestoreOptions,
): { refusals: string[] } {
  const merge = options?.merge === true;
  const refusals: string[] = [];
  const targetIds = new Set<string>();
  const hasLockedField = state?.locked !== undefined;
  const lockedIds = new Set<string>();

  for (const rawId of state?.declared ?? []) {
    const normalized = assertValidFirestoreDatabaseDeclaration(rawId);
    if (normalized !== DEFAULT_FIRESTORE_DATABASE) {
      targetIds.add(normalized);
    }
  }
  for (const rawId of state?.locked ?? []) {
    const normalized = assertValidFirestoreDatabaseDeclaration(rawId);
    if (normalized !== DEFAULT_FIRESTORE_DATABASE) {
      targetIds.add(normalized);
      lockedIds.add(normalized);
    }
  }
  for (const rawId of Object.keys(state?.databases ?? {})) {
    const normalized = assertValidFirestoreDatabaseDeclaration(rawId);
    if (normalized !== DEFAULT_FIRESTORE_DATABASE) {
      targetIds.add(normalized);
    }
  }
  for (const rawId of Object.keys(state?.rules ?? {})) {
    const normalized = assertValidFirestoreDatabaseDeclaration(rawId);
    if (normalized !== DEFAULT_FIRESTORE_DATABASE) {
      targetIds.add(normalized);
    }
  }

  if (!merge) {
    for (const existingId of listDeclaredFirestoreDatabases(sandbox)) {
      if (!targetIds.has(existingId)) {
        undeclareFirestoreDatabase(sandbox, existingId);
      }
    }
  }

  const rulesMap = state?.rules ?? {};
  const databasesMap = state?.databases ?? {};
  const sortedIds = [...targetIds].sort();

  for (const dbId of sortedIds) {
    if (hasLockedField) {
      declareFirestoreDatabase(sandbox, dbId, { locked: lockedIds.has(dbId) });
    } else if (!merge) {
      declareFirestoreDatabase(sandbox, dbId, { locked: false });
    } else {
      declareFirestoreDatabase(sandbox, dbId);
    }
    const env = getDatabaseEnv(sandbox, dbId);

    if (Object.hasOwn(rulesMap, dbId)) {
      const ruleSource = rulesMap[dbId];
      if (typeof ruleSource === 'string' && ruleSource.length > 0) {
        const rejection = rulesSourceRejection(ruleSource);
        if (rejection !== null) {
          refusals.push(`Firestore (${dbId}) ${rejection.message}`);
        } else {
          env.deployRules(ruleSource);
        }
      } else if (!merge) {
        resetFirestoreDatabaseToDefaultPolicy(sandbox, dbId);
      }
    } else if (!merge) {
      resetFirestoreDatabaseToDefaultPolicy(sandbox, dbId);
    }

    const rawDocs = Object.hasOwn(databasesMap, dbId) ? databasesMap[dbId] ?? {} : {};
    const normalizedDocs = new Map<string, Record<string, unknown>>();
    for (const [rawPath, encodedData] of Object.entries(rawDocs)) {
      const cleanPath = normalizeDocPath(rawPath);
      if (cleanPath.length === 0) continue;
      normalizedDocs.set(cleanPath, decodeSnapshotMapForEnv(encodedData));
    }
    if (!merge) {
      for (const existingPath of Object.keys(env.snapshot())) {
        if (!normalizedDocs.has(existingPath)) {
          env.adminDeleteDocument(existingPath);
        }
      }
    }
    for (const [path, decodedData] of normalizedDocs.entries()) {
      env.adminSetDocument(path, decodedData);
    }
  }

  markAllNamedFirestoreDirty(sandbox);
  return { refusals };
}
