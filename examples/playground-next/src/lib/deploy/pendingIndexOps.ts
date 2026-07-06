/**
 * Read / write the set of long-running index-create operations the
 * playground started. The progress UI (`useIndexesProgress`) and the
 * per-track / orchestrating deploy hooks share this store so a
 * refresh doesn't lose pending operations and so newly-started ops
 * show up in the progress panel immediately.
 */

const STORAGE_KEY = 'pyric:pendingIndexOps';
const CHANGE_EVENT = 'pyric:pendingIndexOpsChanged';

/**
 * `CREATING` and `READY` come from the Firestore Admin API directly;
 * `NEEDS_REPAIR` is also an API state. `failed` covers the case where
 * `getStatus` returned `{ ok: false }` (build itself errored). `NOT_FOUND`
 * comes from the API when the operation handle is unknown (e.g. the
 * caller deleted the index).
 */
export type IndexOperationState =
  | 'CREATING'
  | 'READY'
  | 'NEEDS_REPAIR'
  | 'NOT_FOUND'
  | 'failed';

export interface IndexOperationStatus {
  operationName: string;
  state: IndexOperationState;
  collectionGroup: string;
  fields: { fieldPath: string; order?: string; arrayConfig?: string }[];
  /** Last time the progress poller checked this op's state. */
  lastPolledAt?: string;
  /** Human-readable error when `state === 'failed'`. */
  error?: string;
}

export function readPendingOps(): IndexOperationStatus[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as IndexOperationStatus[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Append `ops` to whatever's persisted, de-duped by `operationName`.
 * Fires the change event so progress subscribers refresh immediately
 * (no polling lag between deploy completion and UI update).
 */
export function writePendingOps(ops: IndexOperationStatus[]): void {
  if (typeof window === 'undefined') return;
  if (ops.length === 0) return;
  try {
    const prior = readPendingOps();
    const merged = dedupeByName([...prior, ...ops]);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch (e) {
    console.warn('[pendingIndexOps] localStorage write failed:', e);
  }
}

/**
 * Replace the persisted set with `ops`. Used by the progress hook to
 * prune entries that finished building. Empty `ops` clears the key
 * entirely.
 */
export function replacePendingOps(ops: IndexOperationStatus[]): void {
  if (typeof window === 'undefined') return;
  try {
    if (ops.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(dedupeByName(ops)));
    }
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch (e) {
    console.warn('[pendingIndexOps] localStorage replace failed:', e);
  }
}

/** Subscribe to any change to the pending set. Returns an unsubscribe. */
export function subscribePendingOpsChanges(fn: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CHANGE_EVENT, fn);
  return () => window.removeEventListener(CHANGE_EVENT, fn);
}

function dedupeByName(ops: IndexOperationStatus[]): IndexOperationStatus[] {
  const seen = new Set<string>();
  const out: IndexOperationStatus[] = [];
  for (const op of ops) {
    if (seen.has(op.operationName)) continue;
    seen.add(op.operationName);
    out.push(op);
  }
  return out;
}
