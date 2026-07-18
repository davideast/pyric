/**
 * LocalState — in-memory Firestore document store.
 *
 * Manages a Map<string, Record<string, unknown>> with correct Firestore
 * semantics for create, update (merge), delete, and set (overwrite).
 *
 * This is the "database" for the local environment. The simulator
 * evaluates rules; this class manages the data those rules protect.
 *
 * Write-boundary resolver:
 *   Every mutation (`create`, `update`, `set`, `applyBatch`, and the
 *   constructor seed pass) routes through {@link resolveValueTree}
 *   before the value lands in storage. The resolver is the single
 *   chokepoint where Date → Timestamp coercion, FieldValue sentinel
 *   resolution, DocumentReference wrapping, etc. happen (see
 *   value-resolver.ts). Today the registry is empty (Item 0); Items 1+
 *   plug in converters without touching this file.
 *
 *   Idempotency: callers higher up the stack (e.g.,
 *   `LocalEnvironment.execute`) may resolve before us so rules see the
 *   same shape storage will see. Double-resolution is intentional and
 *   safe — every converter is required to no-op on its own output.
 */
import { resolveValueTree, partitionDeletes } from './value-resolver.js';
import { applyUpdate, applyMerge } from './field-merge.js';

export type DocumentData = Record<string, unknown>;

/** One row from a {@link DocStore} scan/list. */
export interface DocEntry {
  path: string;
  data: DocumentData;
  /** Synthesized parent of deeper descendants (no stored doc of its own). */
  phantom?: true;
}

/** Options for {@link DocStore.scan}. */
export interface ScanOptions {
  /** Only direct children of the prefix (a collection scan), not all descendants. */
  directOnly?: boolean;
  /** Synthesize phantom-parent entries for paths whose parent has no stored doc. */
  phantoms?: boolean;
  /** Project each emitted doc's data down to only these top-level fields (others
   *  omitted), so callers can skip large fields like vectors. Phantoms stay `{}`. */
  projection?: readonly string[];
}

/**
 * The store seam over the document keyspace. Everything that touches documents
 * (queries, listeners, the worker, branches, writes, undo) goes through this
 * contract rather than a raw Map, so the backing store can be swapped (a CoW
 * overlay for branches, chunked persistence) without touching the callers.
 * `scan` is the single read-iteration primitive; `list` builds on it.
 * Synchronous by design: the rules simulator consumes pre-resolved reads, so the
 * read path cannot go async.
 */
export interface DocStore {
  // Reads
  get(path: string): DocumentData | null;
  exists(path: string): boolean;
  scan(prefix: string, opts?: ScanOptions): DocEntry[];
  list(collection: string): DocEntry[];
  listRootCollections(): string[];
  listSubcollections(docPath: string): string[];
  snapshot(): Record<string, DocumentData>;
  size(): number;
  // Writes
  create(path: string, data: DocumentData): CreateResult;
  update(path: string, data: DocumentData): UpdateResult;
  set(path: string, data: DocumentData): SetResult;
  setMerge(path: string, data: DocumentData, mergeFields?: readonly string[]): SetResult;
  delete(path: string): DeleteResult;
  applyBatch(operations: BatchOperation[]): BatchResult;
  // Undo support
  restore(snapshot: Record<string, DocumentData>): void;
  restorePaths(priorDocs: Record<string, DocumentData | null>): void;
}

/**
 * The raw key->doc backing under {@link LocalState}: the subset of `Map` the
 * store uses. A plain `Map` satisfies it (the default); branches inject an
 * `OverlayBacking` for copy-on-write over an immutable base, so the store's
 * read/write/merge logic is reused unchanged over either backing.
 */
export interface DocBacking {
  get(path: string): DocumentData | undefined;
  set(path: string, data: DocumentData): void;
  has(path: string): boolean;
  delete(path: string): boolean;
  clear(): void;
  keys(): IterableIterator<string>;
  readonly size: number;
  [Symbol.iterator](): IterableIterator<[string, DocumentData]>;
}

/** Pick only `fields` from `data` (a shallow top-level projection). */
function projectFields(data: DocumentData, fields: readonly string[]): DocumentData {
  const out: DocumentData = {};
  for (const f of fields) {
    if (Object.prototype.hasOwnProperty.call(data, f)) out[f] = data[f];
  }
  return out;
}

export class LocalState implements DocStore {
  private documents: DocBacking;

  constructor(seed: Record<string, DocumentData> = {}, backing?: DocBacking) {
    this.documents = backing ?? new Map();
    for (const [path, data] of Object.entries(seed)) {
      // Seed pass: no prior state, method='seed' so converters can branch.
      const resolved = resolveValueTree({ ...data }, {
        path,
        method: 'seed',
        prior: null,
      });
      // Item 2: drop any DELETE_FIELD sentinels in the seed (a rare but
      // legal shape if the agent reuses payload objects). No prior to
      // delete from on a seed; we just strip the markers.
      const { writes } = partitionDeletes(resolved);
      this.documents.set(path, writes);
    }
  }

  // ═══ Read operations ═══

  /** Get a single document. Returns null if not found. */
  get(path: string): DocumentData | null {
    return this.documents.get(path) ?? null;
  }

  /** Check if a document exists. */
  exists(path: string): boolean {
    return this.documents.has(path);
  }

  /**
   * Scan the keyspace under `prefix`: the single iteration primitive `list`
   * (and, later, the query engine) build on. With `directOnly`, returns only
   * direct children of `prefix` (a collection scan); otherwise every descendant.
   * With `phantoms`, synthesizes empty parent entries for paths whose parent has
   * descendants but no stored doc of its own (mirrors live Firestore's
   * `listDocuments`). An empty `prefix` scans the whole keyspace. Real stored
   * docs come in keyspace (insertion) order; phantoms are appended after, so a
   * real doc always wins over its phantom synthesis.
   */
  scan(prefix: string, opts: ScanOptions = {}): DocEntry[] {
    const norm = prefix === '' || prefix.endsWith('/') ? prefix : prefix + '/';
    const project = opts.projection
      ? (d: DocumentData) => projectFields(d, opts.projection!)
      : (d: DocumentData) => d;
    const results: DocEntry[] = [];
    const seenIds = new Set<string>();
    const phantomIds: string[] = [];
    for (const [path, data] of this.documents) {
      if (norm !== '' && !path.startsWith(norm)) continue;
      if (!opts.directOnly) {
        results.push({ path, data: project(data) });
        continue;
      }
      const remainder = path.slice(norm.length);
      const slashIdx = remainder.indexOf('/');
      if (slashIdx === -1) {
        // Direct child — real stored doc.
        results.push({ path, data: project(data) });
        seenIds.add(remainder);
      } else if (opts.phantoms) {
        // Deeper descendant — its top segment is a parent id under our
        // collection. Record once; synthesize after the scan so real
        // stored docs win over the phantom synthesis.
        const parentId = remainder.slice(0, slashIdx);
        if (parentId.length > 0 && !phantomIds.includes(parentId)) {
          phantomIds.push(parentId);
        }
      }
    }
    if (opts.directOnly && opts.phantoms) {
      for (const id of phantomIds) {
        if (seenIds.has(id)) continue;
        results.push({ path: norm + id, data: {}, phantom: true });
      }
    }
    return results;
  }

  /**
   * List all documents in a collection: real stored direct children plus
   * phantom parents (synthesized empty docs for any parent with descendants).
   * Mirrors live Firestore's `listDocuments`; `getDocument(path)` still returns
   * `null` for a phantom; phantoms only surface via list traversal. This is
   * `scan(collection, { directOnly, phantoms })`.
   */
  list(collection: string): DocEntry[] {
    return this.scan(collection, { directOnly: true, phantoms: true });
  }

  /**
   * List all root collection IDs derived from the document keyspace.
   * For seeded paths `users/u1`, `users/u1/posts/p1`, `articles/a1`, returns
   * `['users', 'articles']` (deduped, insertion order).
   *
   * Note: a collection is "visible" if any document path lives under it.
   * Phantom parents (e.g., a path `users/u1/posts/p1` with no `users/u1`
   * stored doc) still surface their root collection here, mirroring how
   * real Firestore exposes a collection whenever any descendant exists.
   */
  listRootCollections(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const path of this.documents.keys()) {
      const first = path.split('/', 1)[0]!;
      if (first.length === 0) continue;
      if (!seen.has(first)) {
        seen.add(first);
        out.push(first);
      }
    }
    return out;
  }

  /**
   * List subcollection IDs directly underneath the given document path.
   * For docPath `users/u1` and stored paths `users/u1/posts/p1`,
   * `users/u1/posts/p2`, `users/u1/sessions/s1`, returns `['posts', 'sessions']`.
   *
   * Like {@link listRootCollections}, a subcollection is visible whenever
   * any descendant path exists — it does NOT require the parent doc to
   * have stored data.
   */
  listSubcollections(docPath: string): string[] {
    const prefix = docPath.endsWith('/') ? docPath : docPath + '/';
    const seen = new Set<string>();
    const out: string[] = [];
    for (const path of this.documents.keys()) {
      if (!path.startsWith(prefix)) continue;
      const remainder = path.slice(prefix.length);
      const next = remainder.split('/', 1)[0]!;
      if (next.length === 0) continue;
      if (!seen.has(next)) {
        seen.add(next);
        out.push(next);
      }
    }
    return out;
  }

  /** Get all documents as a plain object. */
  snapshot(): Record<string, DocumentData> {
    const snap: Record<string, DocumentData> = {};
    for (const [path, data] of this.documents) {
      snap[path] = { ...data };
    }
    return snap;
  }

  /** Total document count. */
  size(): number {
    return this.documents.size;
  }

  // ═══ Write operations ═══

  /**
   * Create a document. Fails if the document already exists.
   * Sets the full document data (no merge).
   */
  create(path: string, data: DocumentData): CreateResult {
    if (this.documents.has(path)) {
      return { success: false, error: `Document '${path}' already exists` };
    }
    let writes: DocumentData;
    try {
      const resolved = resolveValueTree({ ...data }, {
        path,
        method: 'create',
        prior: null,
      });
      // Item 2: create has no prior, so deletedKeys are no-ops; we just
      // strip the markers so they don't land in storage.
      writes = partitionDeletes(resolved).writes;
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
    this.documents.set(path, writes);
    return { success: true };
  }

  /**
   * Update a document. Fails if the document doesn't exist.
   * MERGES fields — does not replace the entire document.
   * Firestore update() semantics: existing fields not in the update are preserved.
   */
  update(path: string, data: DocumentData): UpdateResult {
    const existing = this.documents.get(path);
    if (!existing) {
      return { success: false, error: `Document '${path}' does not exist` };
    }
    let merged: DocumentData;
    try {
      const resolved = resolveValueTree({ ...data }, {
        path,
        method: 'update',
        prior: existing,
      });
      // FS-B5: top-level `updateDoc` keys are dot-separated FieldPaths.
      // `applyUpdate` expands `{'a.b': v}` into a nested set (preserving
      // `a.c`), replaces a whole map for a single-segment key, and removes
      // DELETE_FIELD-marked leaves — matching prod's PatchMutation.
      merged = applyUpdate(existing, resolved);
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
    this.documents.set(path, merged);
    return { success: true, priorData: { ...existing } };
  }

  /**
   * Merge-set a document — `setDoc(data, {merge:true})` /
   * `{mergeFields}`. Deep-merges nested maps into the existing doc
   * (FS-B6): `setDoc({a:{b:2}}, {merge:true})` over `{a:{c:1}}` yields
   * `{a:{b:2,c:1}}`. Creates the doc if absent. `mergeFields` restricts
   * the write to the listed (dot-separated) field paths.
   */
  setMerge(
    path: string,
    data: DocumentData,
    mergeFields?: readonly string[],
  ): SetResult {
    const priorData = this.documents.has(path)
      ? { ...this.documents.get(path)! }
      : null;
    const resolved = resolveValueTree({ ...data }, {
      path,
      method: 'set',
      prior: priorData,
    });
    const merged = applyMerge(priorData ?? {}, resolved, mergeFields);
    this.documents.set(path, merged);
    return { success: true, priorData, created: priorData === null };
  }

  /**
   * Set a document. Creates or overwrites — always succeeds.
   * Replaces the entire document (no merge).
   */
  set(path: string, data: DocumentData): SetResult {
    const priorData = this.documents.has(path)
      ? { ...this.documents.get(path)! }
      : null;
    const resolved = resolveValueTree({ ...data }, {
      path,
      method: 'set',
      prior: priorData,
    });
    // Item 2: set replaces the doc entirely, so deletedKeys have no
    // existing field to remove — but we still strip the markers so
    // they don't reach storage. Real Firestore rejects deleteField()
    // inside a non-merge set; we accept-and-strip for now since merge
    // mode isn't yet plumbed into the simulator's set path.
    const { writes } = partitionDeletes(resolved);
    this.documents.set(path, writes);
    return { success: true, priorData, created: priorData === null };
  }

  /**
   * Delete a document. Fails if the document doesn't exist.
   * Returns the deleted data (for undo).
   */
  delete(path: string): DeleteResult {
    const existing = this.documents.get(path);
    if (!existing) {
      return { success: false, error: `Document '${path}' does not exist` };
    }
    this.documents.delete(path);
    return { success: true, priorData: { ...existing } };
  }

  // ═══ Batch operations ═══

  /**
   * Apply multiple writes atomically.
   * Evaluates all operations against CURRENT state (no cross-visibility).
   * If all succeed, applies all. If any fails, none apply.
   *
   * Note: This handles the DATA side only. Rules evaluation is the caller's
   * responsibility (LocalEnvironment evaluates rules, then calls batch).
   */
  applyBatch(operations: BatchOperation[]): BatchResult {
    // Validate all operations against current state first
    const errors: { index: number; error: string }[] = [];
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      switch (op.method) {
        case 'create':
          if (this.documents.has(op.path)) {
            errors.push({ index: i, error: `Document '${op.path}' already exists` });
          }
          break;
        case 'update':
          if (!this.documents.has(op.path)) {
            errors.push({ index: i, error: `Document '${op.path}' does not exist` });
          }
          break;
        case 'delete':
          // Delete-missing is a no-op in production: `WriteBatch.delete`
          // and `Transaction.delete` on an absent doc resolve cleanly,
          // matching the single-op `deleteDoc` contract (matrix row
          // Firestore #39, oracle:
          // packages/conformance/observations/firestore/firestore-deletedoc-missing.json).
          // Apply phase below tolerates the absence via `documents.delete`,
          // which is itself a no-op on a missing key.
          break;
        // 'set' always succeeds
      }
    }

    if (errors.length > 0) {
      return { success: false, errors };
    }

    // Capture prior state for all affected documents (for undo)
    const priorStates = new Map<string, DocumentData | null>();
    for (const op of operations) {
      if (!priorStates.has(op.path)) {
        priorStates.set(op.path, this.documents.has(op.path) ? { ...this.documents.get(op.path)! } : null);
      }
    }

    // Apply all operations. Each non-delete write routes through the
    // resolver with the correct prior — captured above, so resolution
    // order within the batch sees the same prior the rules saw. Item 2:
    // every non-delete branch partitions DELETE_FIELD markers out via
    // partitionDeletes so they don't leak into storage.
    for (const op of operations) {
      switch (op.method) {
        case 'create': {
          const resolved = resolveValueTree({ ...op.data! }, {
            path: op.path,
            method: 'create',
            prior: null,
          });
          const { writes } = partitionDeletes(resolved);
          this.documents.set(op.path, writes);
          break;
        }
        case 'update': {
          const existing = this.documents.get(op.path)!;
          const resolved = resolveValueTree({ ...op.data! }, {
            path: op.path,
            method: 'update',
            prior: existing,
          });
          // FS-B5: dot-path FieldPath expansion + sibling-preserving merge.
          this.documents.set(op.path, applyUpdate(existing, resolved));
          break;
        }
        case 'set': {
          const priorForSet = priorStates.get(op.path) ?? null;
          const resolved = resolveValueTree({ ...op.data! }, {
            path: op.path,
            method: 'set',
            prior: priorForSet,
          });
          const { writes } = partitionDeletes(resolved);
          this.documents.set(op.path, writes);
          break;
        }
        case 'delete':
          this.documents.delete(op.path);
          break;
      }
    }

    return { success: true, priorStates };
  }

  /**
   * Restore state from a WHOLE-keyspace snapshot (reset to seed, transaction
   * undo). Replaces the entire keyspace.
   */
  restore(snapshot: Record<string, DocumentData>): void {
    this.documents.clear();
    for (const [path, data] of Object.entries(snapshot)) {
      this.documents.set(path, { ...data });
    }
  }

  /**
   * Restore only the given paths to their prior state (for single-write / batch
   * undo). `null` means the doc did not exist before, so undo deletes it; any
   * other path in the keyspace is left untouched. This is the affected-path
   * counterpart to {@link restore} that keeps undo O(affected), not O(keyspace).
   */
  restorePaths(priorDocs: Record<string, DocumentData | null>): void {
    for (const [path, data] of Object.entries(priorDocs)) {
      if (data === null) this.documents.delete(path);
      else this.documents.set(path, { ...data });
    }
  }

}

// ═══ Types ═══

export interface CreateResult {
  success: boolean;
  error?: string;
}

export interface UpdateResult {
  success: boolean;
  error?: string;
  priorData?: DocumentData;
}

export interface SetResult {
  success: true;
  priorData: DocumentData | null;
  created: boolean;
}

export interface DeleteResult {
  success: boolean;
  error?: string;
  priorData?: DocumentData;
}

export interface BatchOperation {
  method: 'create' | 'update' | 'set' | 'delete';
  path: string;
  data?: DocumentData;
}

export interface BatchResult {
  success: boolean;
  errors?: { index: number; error: string }[];
  priorStates?: Map<string, DocumentData | null>;
}
