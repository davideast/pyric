/**
 * Option, result, and persisted-session types for `firestore_discover_paths`.
 */
import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
} from './firestore-source.js';
import type {
  CollectionSchema,
  DiscoverEvent,
} from './types.js';

/**
 * Crawl options. All fields are optional with documented defaults.
 *
 * - `maxConcurrency`: in-flight RPC cap (default 32).
 * - `maxDepth`: hard cap on BFS layers from the root (default 10).
 * - `rootFilter`: optional predicate on root collection IDs.
 */
export interface CrawlOptions {
  maxConcurrency?: number;
  maxDepth?: number;
  rootFilter?: (collectionId: string) => boolean;
  /** Hard cap on docs sampled per templatePath (default 50). */
  maxSamples?: number;
  /**
   * Per-templatePath cap on tolerated PERMISSION_DENIED / transient errors
   * during sampling (default 3). Past this threshold, sampling stops and
   * `samplingComplete` becomes `sampling_open`.
   */
  maxErrorsPerCollection?: number;
  /**
   * Adaptive early-exit threshold (default 8). After this many consecutive
   * no-change merges in a templatePath's sampling stream, sampling stops
   * and `samplingComplete` becomes `converged_via_stable`.
   */
  stopOnStable?: number;
  /**
   * Resume a previously paused crawl when a `SessionStore` is passed to
   * `crawl()`. Malformed/expired tokens surface as an error event.
   */
  continuation?: string;
  /**
   * Pause threshold for batch payload size in JSON bytes (default 1 MB).
   * Effective only when a `SessionStore` is provided to `crawl()`.
   */
  maxBatchBytes?: number;
  /**
   * Informational-only cost preview (default `false`). Issues one
   * `db.listCollections()` at the root and returns a heuristic projection.
   */
  dryRun?: boolean;
  /**
   * Heuristic multiplier used in the dryRun cost projection (default 3):
   * assumes each root collection has roughly this many subtree collections.
   */
  dryRunSubtreeMultiplier?: number;
}

export const DEFAULT_MAX_CONCURRENCY = 32;
export const DEFAULT_MAX_DEPTH = 10;
export const DEFAULT_MAX_SAMPLES = 50;
export const DEFAULT_MAX_ERRORS_PER_COLLECTION = 3;
export const DEFAULT_DRY_RUN_SUBTREE_MULTIPLIER = 3;
export const DEFAULT_STOP_ON_STABLE = 8;
export const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

/**
 * Per-template-path bookkeeping built up during a crawl. Multiple concrete
 * collection paths that share a template path (e.g. `users/uid_1/posts` and
 * `users/uid_2/posts` -> `users/{userId}/posts`) accumulate under one entry.
 */
export interface DiscoveredCollection {
  templatePath: string;
  depth: number;
  /** First concrete collection path encountered for this template. */
  examplePath: string;
  /** All concrete collection refs that share this template path. */
  refs: CrawlerCollectionRef[];
  /** Doc refs accumulated across `refs` during BFS expansion. */
  docRefs: CrawlerDocumentRef[];
}

export interface CrawlResult {
  events: DiscoverEvent[];
  discovered: Map<string, DiscoveredCollection>;
  /** Total `listCollections` + `listDocuments` calls. */
  listOps: number;
}

/**
 * Result of a full crawl (structure + sampling). `continuation` is present iff
 * the crawl paused at a `maxBatchBytes` boundary; `complete` is true iff no
 * continuation is pending. Counters (`listOps`, `readOps`) are cumulative.
 */
export interface FullCrawlResult extends CrawlResult {
  finalizedSchemas: Map<string, CollectionSchema>;
  /** `.get()` calls issued during sampling. */
  readOps: number;
  /** Opaque resume handle (only present when paused). */
  continuation?: string;
  /** True iff the crawl completed (no continuation pending). */
  complete: boolean;
  /** Heuristic projection returned when `dryRun: true`. */
  dryRunCostEstimate?: DryRunCostEstimate;
}

/**
 * Upper-bound heuristic cost projection returned by `dryRun: true`.
 */
export interface DryRunCostEstimate {
  rootCollectionCount: number;
  rootCollectionIds: string[];
  maxSamples: number;
  subtreeMultiplier: number;
  /** `1 + rootCount * subtreeMultiplier`. */
  estimatedListOps: number;
  /** `rootCount * subtreeMultiplier * maxSamples`. */
  estimatedReadOps: number;
}

/**
 * JSON-serializable snapshot of an in-progress crawl stored between batches.
 * Collection and document refs are persisted as path strings and reconstructed
 * via `db.collection(path)` / `db.doc(path)` on resume.
 */
export interface PersistedCrawlState {
  phase: 'structure' | 'sampling';
  currentDepth: number;
  maxDepth: number;
  frontierPaths: string[];
  discovered: Record<string, PersistedDiscoveredCollection>;
  samplingQueue: string[];
  finalizedSchemas: Record<string, CollectionSchema>;
  listOps: number;
  readOps: number;
}

/** Persisted shape of a `DiscoveredCollection` (refs -> paths). */
export interface PersistedDiscoveredCollection {
  templatePath: string;
  depth: number;
  examplePath: string;
  refPaths: string[];
  docRefPaths: string[];
}
