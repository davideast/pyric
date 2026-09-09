/**
 * The structural difference between two full sandbox states, service by
 * service.
 *
 * One walk serves both readers. `diff` renders it as {@link BranchDivergence}
 * records that name the service and the path or uid they concern, and
 * `promote` applies the same records as writes. Keeping them on one walk is
 * what makes "what the diff showed" and "what the promotion landed" the same
 * set by construction rather than by two implementations agreeing.
 *
 * The divergence kinds are the replay engine's, unchanged. A branch carries no
 * captured write metadata that could license sentinel or auto-id drift, so
 * every difference here is a `real-divergence`, which is the honest
 * classification for state against state.
 */

import type { JsonValue } from '../../database/sandbox/data-tree.js';
import type {
  AuthAccountsState,
  FullSandboxState,
  StorageObjectState,
} from '../full-state.js';
import type { Divergence } from '../replay/index.js';

/** The services a branch carries, and the names its divergences report. */
export type BranchService = 'firestore' | 'database' | 'storage' | 'auth' | 'rules';

/** One divergence, tagged with the service whose state it concerns. */
export type BranchDivergence = Divergence & { service: BranchService };

/** One change to the Realtime Database tree, at the shallowest path that differs. */
export interface TreeChange {
  path: string;
  before: JsonValue;
  after: JsonValue;
}

/** Structural equality over plain JSON values. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    for (let index = 0; index < a.length; index++) {
      if (!jsonEqual(a[index], b[index])) return false;
    }
    return true;
  }
  const aObject = a as Record<string, unknown>;
  const bObject = b as Record<string, unknown>;
  const aKeys = Object.keys(aObject);
  if (aKeys.length !== Object.keys(bObject).length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObject, key)) return false;
    if (!jsonEqual(aObject[key], bObject[key])) return false;
  }
  return true;
}

/** True when a JSON value is a plain object the walk should descend into. */
function isBranchingNode(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The `data` subtree of a Realtime Database persistence envelope. */
export function databaseTreeOf(state: FullSandboxState): JsonValue {
  const envelope = state.database;
  if (!isBranchingNode(envelope)) return envelope;
  if (!('.pyricRtdbPersistence' in envelope)) return envelope;
  const data = envelope.data;
  if (data === undefined) return null;
  return data;
}

/** The priorities map of a Realtime Database persistence envelope. */
export function databasePrioritiesOf(state: FullSandboxState): Record<string, JsonValue> {
  const envelope = state.database;
  if (!isBranchingNode(envelope)) return {};
  const priorities = envelope.priorities;
  if (!isBranchingNode(priorities)) return {};
  return priorities;
}

/**
 * Every change between two Realtime Database trees, each at the shallowest
 * path that differs. Two objects are walked key by key; anything else is one
 * change at that path, which is exactly the granularity `adminSet` takes.
 */
export function diffTrees(before: JsonValue, after: JsonValue): TreeChange[] {
  const changes: TreeChange[] = [];
  walkTree(before, after, '', changes);
  return changes;
}

function walkTree(before: JsonValue, after: JsonValue, path: string, out: TreeChange[]): void {
  if (jsonEqual(before, after)) return;
  const bothBranch = isBranchingNode(before) && isBranchingNode(after);
  if (!bothBranch) {
    out.push({ path: path === '' ? '/' : path, before, after });
    return;
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const childPath = path === '' ? key : `${path}/${key}`;
    walkTree(before[key] ?? null, after[key] ?? null, childPath, out);
  }
}

/** One divergence record, built once so every service reports the same shape. */
function divergenceAt(
  service: BranchService,
  path: string,
  field: string | undefined,
  before: unknown,
  after: unknown,
): BranchDivergence {
  if (field === undefined) {
    return { kind: 'real-divergence', service, path, before, after };
  }
  return { kind: 'real-divergence', service, path, field, before, after };
}

/**
 * Field-level walk over one document, producing dotted and bracketed leaf
 * paths (`profile.lastSeen`, `tags[0]`), the same syntax the replay engine's
 * own diff produces.
 */
function walkDocument(
  service: BranchService,
  path: string,
  before: unknown,
  after: unknown,
  out: BranchDivergence[],
): void {
  walk(before, after, '');

  function walk(a: unknown, b: unknown, field: string): void {
    if (jsonEqual(a, b)) return;
    if (isBranchingNode(a) && isBranchingNode(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of keys) {
        const next = field === '' ? key : `${field}.${key}`;
        walk(a[key], b[key], next);
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const length = Math.max(a.length, b.length);
      for (let index = 0; index < length; index++) {
        walk(a[index], b[index], `${field}[${index}]`);
      }
      return;
    }
    let leafField: string | undefined = field;
    if (field === '') leafField = undefined;
    out.push(divergenceAt(service, path, leafField, a, b));
  }
}

/** Firestore documents, by full document path. */
function diffFirestore(before: FullSandboxState, after: FullSandboxState): BranchDivergence[] {
  const out: BranchDivergence[] = [];
  const paths = new Set([...Object.keys(before.firestore), ...Object.keys(after.firestore)]);
  for (const path of paths) {
    const beforeDoc = before.firestore[path];
    const afterDoc = after.firestore[path];
    const oneSideMissing = beforeDoc === undefined || afterDoc === undefined;
    if (oneSideMissing) {
      if (jsonEqual(beforeDoc ?? null, afterDoc ?? null)) continue;
      out.push(divergenceAt('firestore', path, undefined, beforeDoc, afterDoc));
      continue;
    }
    walkDocument('firestore', path, beforeDoc, afterDoc, out);
  }
  return out;
}

/** The Realtime Database tree and its priorities, by database path. */
function diffDatabase(before: FullSandboxState, after: FullSandboxState): BranchDivergence[] {
  const out: BranchDivergence[] = [];
  for (const change of diffTrees(databaseTreeOf(before), databaseTreeOf(after))) {
    out.push(divergenceAt('database', change.path, undefined, change.before, change.after));
  }
  const beforePriorities = databasePrioritiesOf(before);
  const afterPriorities = databasePrioritiesOf(after);
  const paths = new Set([...Object.keys(beforePriorities), ...Object.keys(afterPriorities)]);
  for (const path of paths) {
    if (jsonEqual(beforePriorities[path], afterPriorities[path])) continue;
    out.push(
      divergenceAt('database', path, '.priority', beforePriorities[path], afterPriorities[path]),
    );
  }
  return out;
}

/** Storage objects by path, one map so a missing object is a path-level difference. */
function objectsByPath(
  objects: readonly StorageObjectState[],
): Map<string, StorageObjectState> {
  return new Map(objects.map((object) => [object.path, object]));
}

/** Storage objects, by object path. Bytes, content type, and custom metadata. */
function diffStorage(before: FullSandboxState, after: FullSandboxState): BranchDivergence[] {
  const out: BranchDivergence[] = [];
  const beforeObjects = objectsByPath(before.storage);
  const afterObjects = objectsByPath(after.storage);
  const paths = new Set([...beforeObjects.keys(), ...afterObjects.keys()]);
  for (const path of [...paths].sort()) {
    const beforeObject = beforeObjects.get(path);
    const afterObject = afterObjects.get(path);
    const oneSideMissing = beforeObject === undefined || afterObject === undefined;
    if (oneSideMissing) {
      out.push(divergenceAt('storage', path, undefined, beforeObject, afterObject));
      continue;
    }
    walkDocument('storage', path, beforeObject, afterObject, out);
  }
  return out;
}

/** Auth accounts by uid, plus the provider configuration over them. */
function diffAuth(before: AuthAccountsState, after: AuthAccountsState): BranchDivergence[] {
  const out: BranchDivergence[] = [];
  const beforeUsers = new Map(before.users.map((user) => [user.uid, user]));
  const afterUsers = new Map(after.users.map((user) => [user.uid, user]));
  const uids = new Set([...beforeUsers.keys(), ...afterUsers.keys()]);
  for (const uid of [...uids].sort()) {
    const beforeUser = beforeUsers.get(uid);
    const afterUser = afterUsers.get(uid);
    const oneSideMissing = beforeUser === undefined || afterUser === undefined;
    if (oneSideMissing) {
      out.push(divergenceAt('auth', uid, undefined, beforeUser, afterUser));
      continue;
    }
    walkDocument('auth', uid, beforeUser, afterUser, out);
  }
  const providerIds = new Set([
    ...Object.keys(before.providers),
    ...Object.keys(after.providers),
  ]);
  for (const providerId of [...providerIds].sort()) {
    if (before.providers[providerId] === after.providers[providerId]) continue;
    out.push(
      divergenceAt(
        'auth',
        'providers',
        providerId,
        before.providers[providerId],
        after.providers[providerId],
      ),
    );
  }
  return out;
}

/** The three rule sources, each under its own service name as the path. */
function diffRules(before: FullSandboxState, after: FullSandboxState): BranchDivergence[] {
  const out: BranchDivergence[] = [];
  if (before.rules.firestore !== after.rules.firestore) {
    out.push(
      divergenceAt('rules', 'firestore', undefined, before.rules.firestore, after.rules.firestore),
    );
  }
  if (!jsonEqual(before.rules.database, after.rules.database)) {
    out.push(
      divergenceAt('rules', 'database', undefined, before.rules.database, after.rules.database),
    );
  }
  if (before.rules.storage !== after.rules.storage) {
    out.push(
      divergenceAt('rules', 'storage', undefined, before.rules.storage, after.rules.storage),
    );
  }
  return out;
}

/**
 * Every difference between two full sandbox states, ordered service by service:
 * Firestore, then the Realtime Database, then Storage, then auth, then rules.
 *
 * `before` is the reference and `after` is the state being described, so a
 * record's `before` and `after` read the way a caller asking "what would
 * landing this change do" expects.
 */
export function diffFullStates(
  before: FullSandboxState,
  after: FullSandboxState,
): BranchDivergence[] {
  return [
    ...diffFirestore(before, after),
    ...diffDatabase(before, after),
    ...diffStorage(before, after),
    ...diffAuth(before.auth, after.auth),
    ...diffRules(before, after),
  ];
}
