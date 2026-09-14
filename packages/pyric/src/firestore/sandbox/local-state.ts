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
 *   value-resolver.ts).
 *
 *   Idempotency: callers higher up the stack (e.g.,
 *   `LocalEnvironment.execute`) may resolve before us so rules see the
 *   same shape storage will see. Double-resolution is intentional and
 *   safe — every converter is required to no-op on its own output.
 */
import { resolveValueTree, partitionDeletes } from './value-resolver.js';
import { applyUpdate, applyMerge } from './field-merge.js';
import { applyAtomicBatch } from './atomic-state.js';
import type {
  BatchOperation, BatchResult, CreateResult, DeleteResult, DocBacking, DocEntry,
  DocStore, DocumentData, ScanOptions, SetResult, UpdateResult,
} from './document-store.js';
export type {
  BatchOperation, BatchResult, CreateResult, DeleteResult, DocBacking, DocEntry,
  DocStore, DocumentData, ScanOptions, SetResult, UpdateResult,
} from './document-store.js';

/** Pick only `fields` from `data` (a shallow top-level projection). */
function projectFields(data: DocumentData, fields: readonly string[] | undefined): DocumentData {
  const projectionMissing = fields === undefined;
  if (projectionMissing) throw new TypeError('Projection fields are not iterable');
  const out: DocumentData = {};
  for (const f of fields) {
    const hasField = Object.prototype.hasOwnProperty.call(data, f);
    if (hasField) out[f] = data[f];
  }
  return out;
}

export class LocalState implements DocStore {
  private documents: DocBacking;
  private readonly versions = new Map<string, number>();
  private nextVersion = 1;

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
      this.bumpVersion(path);
    }
  }

  // ═══ Read operations ═══

  /** Get a single document. Returns null if not found. */
  get(path: string): DocumentData | null {
    return this.documents.get(path) ?? null;
  }

  version(path: string): number {
    return this.versions.get(path) ?? 0;
  }

  currentVersion(): number {
    return this.nextVersion - 1;
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
    const prefixIsNormalized = prefix === '' || prefix.endsWith('/');
    const norm = prefixIsNormalized ? prefix : prefix + '/';
    const hasProjection = Boolean(opts.projection);
    let project = (data: DocumentData) => data;
    if (hasProjection) project = (data) => projectFields(data, opts.projection);
    const results: DocEntry[] = [];
    const seenIds = new Set<string>();
    const phantomIds: string[] = [];
    for (const [path, data] of this.documents) {
      const outsidePrefix = norm !== '' && !path.startsWith(norm);
      if (outsidePrefix) continue;
      const includesDescendants = !opts.directOnly;
      if (includesDescendants) {
        results.push({ path, data: project(data) });
        continue;
      }
      const remainder = path.slice(norm.length);
      const slashIdx = remainder.indexOf('/');
      const isDirectChild = slashIdx === -1;
      if (isDirectChild) {
        // Direct child — real stored doc.
        results.push({ path, data: project(data) });
        seenIds.add(remainder);
        continue;
      }
      const includesPhantoms = Boolean(opts.phantoms);
      if (includesPhantoms) {
        // Deeper descendant — its top segment is a parent id under our
        // collection. Record once; synthesize after the scan so real
        // stored docs win over the phantom synthesis.
        const parentId = remainder.slice(0, slashIdx);
        const isNewParent = parentId.length > 0 && !phantomIds.includes(parentId);
        if (isNewParent) {
          phantomIds.push(parentId);
        }
      }
    }
    const includesPhantomParents = Boolean(opts.directOnly && opts.phantoms);
    if (includesPhantomParents) {
      for (const id of phantomIds) {
        const hasStoredDocument = seenIds.has(id);
        if (hasStoredDocument) continue;
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
      const first = path.split('/', 1)[0] ?? '';
      const isEmptySegment = first.length === 0;
      if (isEmptySegment) continue;
      const isNewCollection = !seen.has(first);
      if (isNewCollection) {
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
    const hasTrailingSlash = docPath.endsWith('/');
    const prefix = hasTrailingSlash ? docPath : docPath + '/';
    const seen = new Set<string>();
    const out: string[] = [];
    for (const path of this.documents.keys()) {
      const outsideDocument = !path.startsWith(prefix);
      if (outsideDocument) continue;
      const remainder = path.slice(prefix.length);
      const next = remainder.split('/', 1)[0] ?? '';
      const isEmptySegment = next.length === 0;
      if (isEmptySegment) continue;
      const isNewCollection = !seen.has(next);
      if (isNewCollection) {
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
    const documentExists = this.documents.has(path);
    if (documentExists) {
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
    this.bumpVersion(path);
    return { success: true };
  }

  /**
   * Update a document. Fails if the document doesn't exist.
   * MERGES fields — does not replace the entire document.
   * Firestore update() semantics: existing fields not in the update are preserved.
   */
  update(path: string, data: DocumentData): UpdateResult {
    const existing = this.documents.get(path);
    const documentMissing = !existing;
    if (documentMissing) {
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
    this.bumpVersion(path);
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
    const documentExists = this.documents.has(path);
    let priorData: DocumentData | null = null;
    if (documentExists) priorData = { ...this.documents.get(path) };
    const resolved = resolveValueTree({ ...data }, {
      path,
      method: 'set',
      prior: priorData,
    });
    const merged = applyMerge(priorData ?? {}, resolved, mergeFields);
    this.documents.set(path, merged);
    this.bumpVersion(path);
    return { success: true, priorData, created: priorData === null };
  }

  /**
   * Set a document. Creates or overwrites — always succeeds.
   * Replaces the entire document (no merge).
   */
  set(path: string, data: DocumentData): SetResult {
    const documentExists = this.documents.has(path);
    let priorData: DocumentData | null = null;
    if (documentExists) priorData = { ...this.documents.get(path) };
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
    this.bumpVersion(path);
    return { success: true, priorData, created: priorData === null };
  }

  /**
   * Delete a document. Fails if the document doesn't exist.
   * Returns the deleted data (for undo).
   */
  delete(path: string): DeleteResult {
    const existing = this.documents.get(path);
    const documentMissing = !existing;
    if (documentMissing) {
      return { success: false, error: `Document '${path}' does not exist` };
    }
    this.documents.delete(path);
    this.bumpVersion(path);
    return { success: true, priorData: { ...existing } };
  }

  // ═══ Batch operations ═══

  /**
   * Apply multiple writes atomically.
   * Validates existence preconditions in write order before applying data.
   * If all succeed, applies all. If any fails, none apply.
   *
   * Note: This handles the DATA side only. Rules evaluation is the caller's
   * responsibility (LocalEnvironment evaluates rules, then calls batch).
   */
  applyBatch(operations: BatchOperation[]): BatchResult {
    return applyAtomicBatch(this.documents, operations, (path) => this.bumpVersion(path));
  }

  /**
   * Restore state from a WHOLE-keyspace snapshot (reset to seed, transaction
   * undo). Replaces the entire keyspace.
   */
  restore(snapshot: Record<string, DocumentData>): void {
    const touched = new Set([...this.documents.keys(), ...Object.keys(snapshot)]);
    this.documents.clear();
    for (const [path, data] of Object.entries(snapshot)) {
      this.documents.set(path, { ...data });
    }
    for (const path of touched) this.bumpVersion(path);
  }

  /**
   * Restore only the given paths to their prior state (for single-write / batch
   * undo). `null` means the doc did not exist before, so undo deletes it; any
   * other path in the keyspace is left untouched. This is the affected-path
   * counterpart to {@link restore} that keeps undo O(affected), not O(keyspace).
   */
  restorePaths(priorDocs: Record<string, DocumentData | null>): void {
    for (const [path, data] of Object.entries(priorDocs)) {
      const documentMissing = data === null;
      if (documentMissing) this.documents.delete(path);
      else this.documents.set(path, { ...data });
      this.bumpVersion(path);
    }
  }

  private bumpVersion(path: string): void {
    this.versions.set(path, this.nextVersion++);
  }

}
