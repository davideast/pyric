/**
 * Companion branch persistence, event application, structural diff, and atomic
 * delta promotion for named Firestore databases (ADR-0021 Decision 8).
 *
 * When no named Firestore databases exist in either state, zero extra files or
 * divergences are produced so `(default)`-only branches stay byte-identical.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureNamedFirestoreState,
  DEFAULT_FIRESTORE_DATABASE,
  declareFirestoreDatabase,
  getDatabaseEnv,
  listDeclaredFirestoreDatabases,
  replayNamedFirestoreEventsForDatabase,
  resetFirestoreDatabaseToDefaultPolicy,
  restoreNamedFirestoreState,
  undeclareFirestoreDatabase,
  type NamedFirestoreCapturedState,
} from 'pyric/firestore/internal';
import { jsonEqual } from 'pyric/rules/internal/rtdb';
import {
  apply,
  diff,
  promote,
  type Branch,
  type BranchDivergence,
  type LocalSandbox,
  type SandboxEvent,
  type WriteSandboxEvent,
} from 'pyric/sandbox';
import { branchDirectory } from 'pyric/sandbox/branches/store';
import { decodeSnapshotMapForEnv } from 'pyric/sandbox/internal';

export type NamedBranchDivergence = BranchDivergence & {
  database?: string;
};

const NAMED_FIRESTORE_FILE = 'firestore-databases.json';

function emptyNamedState(): NamedFirestoreCapturedState {
  return { declared: [], databases: {}, rules: {}, documentCount: 0 };
}

function sidecarPath(projectDir: string, branchName: string, sliceDir: 'base' | 'state'): string {
  return join(branchDirectory(projectDir, branchName), sliceDir, NAMED_FIRESTORE_FILE);
}

/** Write named Firestore sidecars under `base/` and `state/` when any named database is declared. */
export function writeBranchNamedFirestore(
  projectDir: string,
  branchName: string,
  baseNamed: NamedFirestoreCapturedState,
  stateNamed: NamedFirestoreCapturedState,
): void {
  const hasAny = baseNamed.declared.length > 0 || stateNamed.declared.length > 0;
  const basePath = sidecarPath(projectDir, branchName, 'base');
  const statePath = sidecarPath(projectDir, branchName, 'state');
  if (!hasAny) {
    rmSync(basePath, { force: true });
    rmSync(statePath, { force: true });
    return;
  }
  mkdirSync(join(branchDirectory(projectDir, branchName), 'base'), { recursive: true });
  mkdirSync(join(branchDirectory(projectDir, branchName), 'state'), { recursive: true });
  writeFileSync(basePath, `${JSON.stringify(baseNamed)}\n`, 'utf8');
  writeFileSync(statePath, `${JSON.stringify(stateNamed)}\n`, 'utf8');
}

/** Read a branch's `base` or `state` named Firestore sidecar, returning an empty state when absent. */
function readBranchNamedFirestore(
  projectDir: string,
  branchName: string,
  sliceDir: 'base' | 'state',
): NamedFirestoreCapturedState {
  const path = sidecarPath(projectDir, branchName, sliceDir);
  if (!existsSync(path)) return emptyNamedState();
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<NamedFirestoreCapturedState>;
  const declared = Array.isArray(parsed.declared) ? parsed.declared.map(String) : [];
  let databases: NamedFirestoreCapturedState['databases'] = {};
  if (parsed.databases !== undefined && typeof parsed.databases === 'object' && parsed.databases !== null) {
    databases = parsed.databases as NamedFirestoreCapturedState['databases'];
  }
  let rules: NamedFirestoreCapturedState['rules'] = {};
  if (parsed.rules !== undefined && typeof parsed.rules === 'object' && parsed.rules !== null) {
    rules = parsed.rules as NamedFirestoreCapturedState['rules'];
  }
  const documentCount = typeof parsed.documentCount === 'number' ? parsed.documentCount : 0;
  const locked = Array.isArray(parsed.locked) ? parsed.locked.map(String) : [];
  if (locked.length > 0) {
    return { declared, databases, rules, locked, documentCount };
  }
  return { declared, databases, rules, documentCount };
}

/** Hydrate stored `state/firestore-databases.json` into a loaded branch's sandbox. */
export function hydrateLoadedBranchNamedFirestore(
  projectDir: string,
  branchName: string,
  branch: Branch,
): { baseNamed: NamedFirestoreCapturedState; stateNamed: NamedFirestoreCapturedState } {
  const baseNamed = readBranchNamedFirestore(projectDir, branchName, 'base');
  const stateNamed = readBranchNamedFirestore(projectDir, branchName, 'state');
  if (stateNamed.declared.length > 0) {
    restoreNamedFirestoreState(branch.sandbox, stateNamed);
  }
  return { baseNamed, stateNamed };
}

function eventNamedDatabaseId(event: SandboxEvent): string | undefined {
  const direct = (event as { database?: unknown }).database;
  if (typeof direct === 'string' && direct.length > 0 && direct !== DEFAULT_FIRESTORE_DATABASE) {
    return direct;
  }
  const detailDb = (event as { detail?: { database?: unknown } }).detail?.database;
  if (
    typeof detailDb === 'string' &&
    detailDb.length > 0 &&
    detailDb !== DEFAULT_FIRESTORE_DATABASE
  ) {
    return detailDb;
  }
  return undefined;
}

function isNamedFirestoreWrite(event: SandboxEvent): event is WriteSandboxEvent & { database: string } {
  if (event.kind !== 'write') return false;
  return eventNamedDatabaseId(event) !== undefined;
}

/** Apply `events` onto `branch`, routing named-database Firestore writes to their own `LocalEnvironment`. */
export function applyEventsWithNamedFirestore(branch: Branch, events: readonly SandboxEvent[]): void {
  const hasNamedWrites = events.some(isNamedFirestoreWrite);
  if (!hasNamedWrites) {
    apply(branch, events);
    return;
  }
  const defaultEvents = events.filter((event) => eventNamedDatabaseId(event) === undefined);
  if (defaultEvents.length > 0) {
    apply(branch, defaultEvents);
    branch.events.length = branch.events.length - defaultEvents.length;
  }
  const namedDatabaseIds: string[] = [];
  const seenDbIds = new Set<string>();
  for (const event of events) {
    if (event.kind !== 'write') continue;
    const dbId = eventNamedDatabaseId(event);
    if (dbId !== undefined && !seenDbIds.has(dbId)) {
      seenDbIds.add(dbId);
      namedDatabaseIds.push(dbId);
    }
  }
  for (const dbId of namedDatabaseIds) {
    replayNamedFirestoreEventsForDatabase(branch.sandbox, dbId, events);
  }
  branch.events.push(...events);
}

function isPlainNode(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walkNamedDocDiff(
  databaseId: string,
  path: string,
  before: unknown,
  after: unknown,
  out: NamedBranchDivergence[],
): void {
  const visit = (left: unknown, right: unknown, field: string): void => {
    if (jsonEqual(left, right)) return;
    if (isPlainNode(left) && isPlainNode(right)) {
      const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const key of keys) {
        const nextField = field === '' ? key : `${field}.${key}`;
        visit(left[key], right[key], nextField);
      }
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const len = Math.max(left.length, right.length);
      for (let i = 0; i < len; i += 1) {
        visit(left[i], right[i], `${field}[${i}]`);
      }
      return;
    }
    const entry: NamedBranchDivergence = {
      kind: 'real-divergence',
      service: 'firestore',
      database: databaseId,
      path,
      before: left,
      after: right,
    };
    if (field !== '') {
      entry.field = field;
    }
    out.push(entry);
  };
  visit(before, after, '');
}

function normalizePlainForDiff(encoded: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (encoded === undefined) return undefined;
  return JSON.parse(JSON.stringify(encoded)) as Record<string, unknown>;
}

/** Diff named Firestore databases and their rules between `beforeNamed` and `afterNamed`. */
function diffNamedFirestoreStates(
  beforeNamed: NamedFirestoreCapturedState | undefined,
  afterNamed: NamedFirestoreCapturedState | undefined,
): { firestore: NamedBranchDivergence[]; rules: NamedBranchDivergence[] } {
  const before = beforeNamed ?? emptyNamedState();
  const after = afterNamed ?? emptyNamedState();
  const dbIds = [
    ...new Set([
      ...before.declared,
      ...after.declared,
      ...Object.keys(before.databases),
      ...Object.keys(after.databases),
      ...Object.keys(before.rules),
      ...Object.keys(after.rules),
    ]),
  ].sort();

  const firestore: NamedBranchDivergence[] = [];
  const rules: NamedBranchDivergence[] = [];

  for (const dbId of dbIds) {
    const beforeDocs = before.databases[dbId] ?? {};
    const afterDocs = after.databases[dbId] ?? {};
    const docPaths = [...new Set([...Object.keys(beforeDocs), ...Object.keys(afterDocs)])].sort();
    for (const docPath of docPaths) {
      const beforeDoc = normalizePlainForDiff(beforeDocs[docPath]);
      const afterDoc = normalizePlainForDiff(afterDocs[docPath]);
      if (beforeDoc === undefined || afterDoc === undefined) {
        if (jsonEqual(beforeDoc ?? null, afterDoc ?? null)) continue;
        firestore.push({
          kind: 'real-divergence',
          service: 'firestore',
          database: dbId,
          path: docPath,
          before: beforeDoc,
          after: afterDoc,
        });
        continue;
      }
      walkNamedDocDiff(dbId, docPath, beforeDoc, afterDoc, firestore);
    }

    const beforeRule = before.rules[dbId] ?? '';
    const afterRule = after.rules[dbId] ?? '';
    if (beforeRule !== afterRule) {
      rules.push({
        kind: 'real-divergence',
        service: 'rules',
        database: dbId,
        path: 'firestore',
        before: beforeRule,
        after: afterRule,
      });
    }
  }

  return { firestore, rules };
}

/** Combine `diff(branch, target)` with named-Firestore document and rule divergences. */
export async function diffBranchWithNamedFirestore(
  branch: Branch,
  target: LocalSandbox | Parameters<typeof diff>[1],
  beforeNamed: NamedFirestoreCapturedState | undefined,
): Promise<NamedBranchDivergence[]> {
  const afterNamed = captureNamedFirestoreState(branch.sandbox);
  const baseDivergences = await diff(branch, target);
  const namedDiff = diffNamedFirestoreStates(beforeNamed, afterNamed);
  if (namedDiff.firestore.length === 0 && namedDiff.rules.length === 0) {
    return baseDivergences;
  }
  const out: NamedBranchDivergence[] = [];
  let insertedFirestore = false;
  let insertedRules = false;
  for (const item of baseDivergences) {
    if (!insertedFirestore && item.service !== 'firestore') {
      out.push(...namedDiff.firestore);
      insertedFirestore = true;
    }
    if (!insertedRules && item.service === 'messaging') {
      out.push(...namedDiff.rules);
      insertedRules = true;
    }
    out.push(item);
  }
  if (!insertedFirestore) {
    out.push(...namedDiff.firestore);
  }
  if (!insertedRules) {
    out.push(...namedDiff.rules);
  }
  return out;
}

/** Atomically promote `branch` and its named Firestore delta onto `target`. */
export async function promoteBranchWithNamedFirestore(
  branch: Branch,
  target: LocalSandbox,
  baseNamed: NamedFirestoreCapturedState,
): Promise<void> {
  const currentNamed = captureNamedFirestoreState(branch.sandbox);
  const rollbackNamed = captureNamedFirestoreState(target);
  await promote(branch, target);
  if (baseNamed.declared.length === 0 && currentNamed.declared.length === 0) {
    return;
  }
  try {
    const baseSet = new Set(baseNamed.declared);
    const currentSet = new Set(currentNamed.declared);
    for (const dbId of baseSet) {
      if (!currentSet.has(dbId) && listDeclaredFirestoreDatabases(target).includes(dbId)) {
        undeclareFirestoreDatabase(target, dbId);
      }
    }
    const baseLockedSet = new Set(baseNamed.locked ?? []);
    const afterLockedSet = new Set(currentNamed.locked ?? []);
    for (const dbId of currentNamed.declared) {
      declareFirestoreDatabase(target, dbId, { locked: afterLockedSet.has(dbId) });
      const env = getDatabaseEnv(target, dbId);
      const baseRule = baseNamed.rules[dbId] ?? '';
      const afterRule = currentNamed.rules[dbId] ?? '';
      const lockedChanged = baseLockedSet.has(dbId) !== afterLockedSet.has(dbId);
      if (baseRule !== afterRule || lockedChanged) {
        if (afterRule.length > 0) {
          env.deployRules(afterRule);
        } else {
          resetFirestoreDatabaseToDefaultPolicy(target, dbId);
        }
      }
      const baseDocs = baseNamed.databases[dbId] ?? {};
      const afterDocs = currentNamed.databases[dbId] ?? {};
      const touchedPaths = new Set([...Object.keys(baseDocs), ...Object.keys(afterDocs)]);
      for (const path of touchedPaths) {
        const beforeDoc = baseDocs[path];
        const afterDoc = afterDocs[path];
        if (jsonEqual(beforeDoc ?? null, afterDoc ?? null)) continue;
        if (afterDoc === undefined) {
          env.adminDeleteDocument(path);
        } else {
          env.adminSetDocument(path, decodeSnapshotMapForEnv(afterDoc));
        }
      }
    }
  } catch (error) {
    restoreNamedFirestoreState(target, rollbackNamed);
    throw error;
  }
}
