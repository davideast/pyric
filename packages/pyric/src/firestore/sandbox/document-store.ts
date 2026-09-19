/** Contracts shared by Firestore document stores and atomic state application. */
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
  /** Monotonic local write version used for optimistic transaction checks. */
  version(path: string): number;
  /** Latest version allocated anywhere in this store. */
  currentVersion(): number;
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
