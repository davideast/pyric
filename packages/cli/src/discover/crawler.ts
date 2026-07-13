/**
 * BFS-layer crawler for `firestore_discover_paths`.
 *
 * Phase 0.3 of the validation plan locked layered BFS with bounded
 * concurrency as the production strategy (38× faster than serial DFS on a
 * 416-doc corpus). This module owns the structure-discovery half of the
 * crawl: enumerate every collection reachable from the root via
 * `listCollections` + `listDocuments` + per-doc `listCollections`. Document
 * sampling and merge integration land in Item 2.3; permission-error
 * resilience lands in Item 2.4.
 *
 * Output of this skeleton:
 *   - `collection_discovered` events emitted as each collection enters the
 *     frontier (depth-tagged so agents can render a tree)
 *   - `discoveredCollections` map with the collection refs collected per
 *     templatePath, ready for Item 2.3 to feed through sampling
 *
 * What this module deliberately does NOT do (yet):
 *   - read any document fields (no `.get()` calls)
 *   - emit `schema_updated` (no merge integration)
 *   - tolerate permission errors (any RPC throw aborts the crawl)
 *   - adaptive sampling, continuation, or dryRun
 */
'use strict';

import { runWithLimit } from './concurrency.js';
import { emptySchema, mergeDoc } from './merge.js';
import { SessionStore, type SessionError } from './session.js';
import { snapshotToObservations } from './wire.js';
import type {
  CrawlerCollectionRef,
  CrawlerDocumentRef,
  CrawlerFirestore,
} from './firestore-source.js';
import type {
  CollectionSchema,
  DiscoverEvent,
  FieldSchema,
  SamplingComplete,
} from './types.js';

// ─── Crawl options ────────────────────────────────────────────────────────

/**
 * Crawl options. All fields are optional with documented defaults.
 *
 * - `maxConcurrency`: in-flight RPC cap. Default 32 per the Risk #1 sweep
 *   on 2026-05-05. Sweep over `{4, 8, 16, 32, 64}` against the corpus
 *   showed `4 → 8 → 16 → 32 → 64` was a steady ~10–15% per-doubling
 *   descent (no plateau). 32 was picked over 64 because the curve hadn't
 *   flattened — 64 was the cap of the test range, not a true knee — and
 *   doubling in-flight RPCs again increases the chance of tripping
 *   per-project connection/quota limits in agent environments. Agents
 *   that want max speed can override.
 * - `maxDepth`: hard cap on BFS layers from the root. Defaults to 10
 *   (well above any real-world Firestore tree). Used as a runaway guard,
 *   not an agent-facing knob.
 * - `rootFilter`: optional predicate on root collection IDs. Used by tests
 *   and the corpus harness to scope discovery to a known prefix without
 *   walking the entire database.
 */
export interface CrawlOptions {
  maxConcurrency?: number;
  maxDepth?: number;
  rootFilter?: (collectionId: string) => boolean;
  /**
   * Hard cap on docs sampled per templatePath. Default 50 per Phase 2.1
   * lock. Item 3 will add adaptive `stopOnStable` early-exit on top of
   * this cap; for now sampling reads exactly `min(maxSamples, available)`
   * docs per templatePath.
   */
  maxSamples?: number;
  /**
   * Per-templatePath cap on tolerated PERMISSION_DENIED / transient errors
   * during sampling. Default 3 per prerequisite 0.E. Past this threshold,
   * sampling for the templatePath stops and `samplingComplete` is set to
   * `sampling_open` so the agent can see the collection wasn't fully
   * sampled. Errors during structure discovery are emitted but do not
   * count toward this cap.
   */
  maxErrorsPerCollection?: number;
  /**
   * Adaptive early-exit threshold. After this many consecutive
   * no-change merges in a templatePath's sampling stream, sampling stops
   * and `samplingComplete` is set to `converged_via_stable`. Default 8 per
   * Phase 2.1 lock. Set to a value > maxSamples to disable early-exit
   * (the hard cap then governs).
   *
   * Reads are issued in chunks of `stopOnStable` so an early-exit avoids
   * fetching the remainder of `sampleRefs`. Worst-case wasted-read
   * count per templatePath is `stopOnStable - 1`.
   */
  stopOnStable?: number;
  /**
   * Resume a previously paused crawl. Only valid when a `SessionStore` is
   * passed to `crawl()`. The token is the `continuation` value from a
   * prior paused result. Malformed/expired tokens surface as a
   * `SESSION_EXPIRED`/`SESSION_EVICTED`/`SESSION_MALFORMED_TOKEN`
   * error event with no other side effects (per 0.C).
   */
  continuation?: string;
  /**
   * Pause threshold for batch payload size. After each layer (structure
   * phase) and each templatePath (sampling phase) the crawler measures
   * the JSON-serialized state size; if it exceeds this many bytes, the
   * crawl pauses and returns a continuation token. Default 1 MB per
   * Phase 0.4 sizing — well below `maxSessionBytes=32MB` so the agent
   * has headroom for response framing.
   *
   * Only effective when a `SessionStore` is provided to `crawl()`. With
   * no store, single-call mode runs to completion regardless of size.
   */
  maxBatchBytes?: number;
  /**
   * Informational-only cost preview. When `true`, the crawler issues
   * exactly **one** RPC — `db.listCollections()` at the root — and
   * returns a heuristic projection of what a real crawl would cost.
   *
   * No documents are read, no per-doc `listCollections` calls are
   * made, no sampling occurs. The result has empty `discovered` and
   * `finalizedSchemas`, `complete: true`, and `continuation: undefined`.
   * It is **not** a partial crawl that can be resumed — to "commit",
   * call `crawl()` again with `dryRun: false` (a fresh full crawl).
   *
   * Rationale: an agent reading `dryRun: true` reasonably expects no
   * real crawl happened. Doing a structure walk under that flag would
   * let the agent make decisions on data it didn't realize it paid
   * for. See Item 5 revision in the implementation plan.
   *
   * Default `false`.
   */
  dryRun?: boolean;
  /**
   * Heuristic multiplier used in the dryRun cost projection: assumes
   * each root collection has roughly this many subtree-collections
   * (root + descendants) on average. Default 3 — conservative for
   * typical app schemas. Surfaced as an option so agents tuning for
   * known shapes can revise.
   *
   * Only consulted when `dryRun: true`.
   */
  dryRunSubtreeMultiplier?: number;
}

const DEFAULT_MAX_CONCURRENCY = 32;
const DEFAULT_MAX_DEPTH = 10;
const DEFAULT_MAX_SAMPLES = 50;
const DEFAULT_MAX_ERRORS_PER_COLLECTION = 3;
/**
 * Default subtree multiplier for the dryRun projection. 3 = "each root
 * collection has, on average, itself + ~2 descendant collections."
 * Conservative for typical app schemas; configurable via
 * `CrawlOptions.dryRunSubtreeMultiplier`.
 */
const DEFAULT_DRY_RUN_SUBTREE_MULTIPLIER = 3;
/**
 * Phase 2.1 lock — `stopOnStable=8` was validated against the real corpus
 * (Phase 2.2) with 0 false positives. Optimistic early-exit signal; the
 * `maxSamples` hard cap remains the absolute ceiling.
 */
const DEFAULT_STOP_ON_STABLE = 8;
/**
 * Default batch payload threshold — pause when the persisted state
 * crosses this many bytes. 1 MB matches Phase 0.4's per-batch budget;
 * leaves ~31 MB of headroom against `maxSessionBytes`.
 */
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;

// ─── Crawl result ─────────────────────────────────────────────────────────

/**
 * Per-template-path bookkeeping built up during a crawl. Collection refs
 * are kept here for Item 2.3 to drive document sampling.
 *
 * Multiple concrete collection paths may collapse to the same template
 * path (e.g. `users/uid_1/posts` and `users/uid_2/posts` both map to
 * `users/{userId}/posts`); their refs are accumulated under one entry.
 */
export interface DiscoveredCollection {
  templatePath: string;
  depth: number;
  /** First concrete collection path encountered for this template. */
  examplePath: string;
  /** All concrete collection refs that share this template path. */
  refs: CrawlerCollectionRef[];
  /**
   * Doc refs accumulated across `refs` during BFS expansion. Sampling
   * draws from this pool — re-listing would double the listDocuments
   * cost we already paid during structure discovery.
   */
  docRefs: CrawlerDocumentRef[];
}

export interface CrawlResult {
  events: DiscoverEvent[];
  discovered: Map<string, DiscoveredCollection>;
  /** Total `listCollections` + `listDocuments` calls — feeds cost reporting. */
  listOps: number;
}

/**
 * Result of a full crawl (structure + sampling). Augments `CrawlResult`
 * with the per-templatePath finalized schemas the agent surface consumes.
 *
 * `continuation` is present iff the crawl paused at a `maxBatchBytes`
 * boundary; agents resume by calling `crawl(db, { continuation }, sessions)`.
 * `complete` is true iff the crawl finished — equivalent to
 * `continuation === undefined` but more readable at call sites.
 *
 * Counter fields (`listOps`, `readOps`) are *cumulative* across batches:
 * a paused crawl returns the running total so the agent's cost-reporting
 * doesn't have to do the bookkeeping.
 */
export interface FullCrawlResult extends CrawlResult {
  finalizedSchemas: Map<string, CollectionSchema>;
  /** `.get()` calls issued during sampling — feeds cost reporting. */
  readOps: number;
  /** Opaque resume handle (only present when paused). */
  continuation?: string;
  /** True iff the crawl completed (no continuation pending). */
  complete: boolean;
  /**
   * Present iff the crawl was a `dryRun: true` preview. Heuristic
   * projection of what a full crawl would cost; see {@link CrawlOptions.dryRun}.
   */
  dryRunCostEstimate?: DryRunCostEstimate;
}

/**
 * Heuristic cost projection returned by `dryRun: true`. The numbers are
 * upper-bound estimates — agents should treat them as "no more than"
 * figures, not exact predictions. Formulas are documented in-line so
 * consumers can sanity-check.
 */
export interface DryRunCostEstimate {
  /** Number of root collections discovered by the single root listCollections call. */
  rootCollectionCount: number;
  /** The root collection IDs (after `rootFilter` is applied, if any). */
  rootCollectionIds: string[];
  /** The `maxSamples` value the projection used. */
  maxSamples: number;
  /** The `dryRunSubtreeMultiplier` value the projection used. */
  subtreeMultiplier: number;
  /**
   * Projected total `listCollections` + `listDocuments` cost of a real
   * crawl: `1 + rootCount × subtreeMultiplier`. The `1` is the root
   * `listCollections`; each subtree contributes one `listDocuments`
   * call to enumerate docs. Per-doc `listCollections` cost is folded
   * into the multiplier (a subtree of 3 implies ~2 layers of doc
   * listings).
   */
  estimatedListOps: number;
  /**
   * Projected total `.get()` cost of sampling: `rootCount ×
   * subtreeMultiplier × maxSamples`. Upper bound — `stopOnStable`
   * early-exit and `cappedByMax` can reduce the actual draw.
   */
  estimatedReadOps: number;
}

// ─── Persisted state (Item 4.2) ───────────────────────────────────────────

/**
 * JSON-serializable snapshot of an in-progress crawl. Stored in the
 * session between batches. Refs (CollectionRef/DocumentRef) carry
 * methods so they can't be persisted directly — we serialize their
 * paths and reconstruct via `db.collection(path)` / `db.doc(path)` on
 * resume.
 *
 * Phase invariants:
 *   - `structure` phase: `frontierPaths` may be non-empty; `samplingQueue`
 *     is empty.
 *   - `sampling` phase: `frontierPaths` is empty; `samplingQueue` lists
 *     the templatePaths still pending. Existing entries in
 *     `finalizedSchemas` are immutable across the rest of the crawl.
 */
export interface PersistedCrawlState {
  phase: 'structure' | 'sampling';
  /** Layer index after the last completed structure pass. */
  currentDepth: number;
  /** Crawl options carried so resume preserves caps the agent set. */
  maxDepth: number;
  /** Concrete collection paths to expand in the next structure layer. */
  frontierPaths: string[];
  /** Discovered map serialized — all paths only, refs reconstructed on resume. */
  discovered: Record<string, PersistedDiscoveredCollection>;
  /** TemplatePaths still to sample. Drained left-to-right. */
  samplingQueue: string[];
  /** Per-templatePath finalized schemas — immutable once set. */
  finalizedSchemas: Record<string, CollectionSchema>;
  /** Cumulative cost counters across batches. */
  listOps: number;
  readOps: number;
}

/** Persisted shape of a `DiscoveredCollection` (refs → paths). */
export interface PersistedDiscoveredCollection {
  templatePath: string;
  depth: number;
  examplePath: string;
  refPaths: string[];
  docRefPaths: string[];
}

// ─── Template-path inference ──────────────────────────────────────────────

/**
 * Map a concrete collection path to its template-path form per Phase 3.1
 * lock. Doc-id segments become `{singular(parentColl)Id}` so the result
 * matches Firestore rules' `path.raw` segments under typical naming
 * conventions (TTT corpus verified: `ttt_lobbies` → `{lobbyId}`).
 *
 * Inputs alternate `coll/doc/coll/doc/.../coll`. Length is always odd (a
 * collection path ends on a collection segment).
 *
 * Heuristic — agents needing strict alignment with rules should normalize
 * both sides before joining. See Risk 6 in the implementation plan.
 *
 * Examples:
 *   `users` → `users`
 *   `users/uid_1/posts` → `users/{userId}/posts`
 *   `ttt_lobbies/abc/games/g1/moves` → `ttt_lobbies/{lobbyId}/games/{gameId}/moves`
 */
export function toTemplatePath(concretePath: string): string {
  const segs = concretePath.split('/');
  if (segs.length % 2 === 0) {
    throw new Error(
      `toTemplatePath: expected odd-length collection path, got ${segs.length} segments: ${concretePath}`,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < segs.length; i++) {
    if (i % 2 === 0) {
      out.push(segs[i]!); // collection segment
    } else {
      const parentColl = segs[i - 1]!;
      out.push(`{${inferTemplateVariable(parentColl)}}`);
    }
  }
  return out.join('/');
}

/**
 * Convert a collection ID to the conventional template-variable name a
 * Firestore rules author would write for its docs. Strips a trailing
 * snake/dot-cased prefix word so `ttt_lobbies` → `lobbyId` (not
 * `ttt_lobbieId`).
 */
export function inferTemplateVariable(collectionId: string): string {
  // Take the last underscore-separated word — `ttt_lobbies` → `lobbies`,
  // `users` → `users`. Lets compound prefixes (test harness, app
  // namespace) drop out of the derived variable name.
  const lastWord = collectionId.split('_').pop() ?? collectionId;
  const singular = singularize(lastWord);
  return `${singular}Id`;
}

/** Trivial English singularizer covering the cases the corpus exercises. */
function singularize(word: string): string {
  if (word.length <= 2) return word; // too short to safely strip
  if (word.endsWith('ies')) return word.slice(0, -3) + 'y'; // lobbies → lobby
  if (word.endsWith('ses')) return word.slice(0, -2); // classes → class
  if (word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1); // users → user
  return word;
}

// ─── Error classification (0.E) ───────────────────────────────────────────

/**
 * gRPC status codes (and stringified equivalents) that the crawler treats
 * as recoverable per prerequisite 0.E. Any other thrown error escapes —
 * silent swallowing of structural errors would mask real bugs.
 *
 * - PERMISSION_DENIED (7): the canonical "subcollection has restricted IAM"
 * - UNAVAILABLE (14):       transient — tool surfaces it, agent retries
 * - DEADLINE_EXCEEDED (4):  transient — same
 * - ABORTED (10):           transient — same
 *
 * firebase-admin throws errors with `code` either as a numeric gRPC code
 * or as a string ('permission-denied'); match both.
 */
const RETRYABLE_NUMERIC_CODES = new Set([4, 7, 10, 14]);
const RETRYABLE_STRING_CODES = new Set([
  'PERMISSION_DENIED',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'ABORTED',
  'permission-denied',
  'unavailable',
  'deadline-exceeded',
  'aborted',
]);

interface ClassifiedError {
  code: string;
  message: string;
}

function classifyRpcError(err: unknown): ClassifiedError | null {
  if (err === null || typeof err !== 'object') return null;
  const e = err as { code?: unknown; message?: unknown };
  let codeStr: string | null = null;
  if (typeof e.code === 'number' && RETRYABLE_NUMERIC_CODES.has(e.code)) {
    codeStr = numericCodeToString(e.code);
  } else if (typeof e.code === 'string' && RETRYABLE_STRING_CODES.has(e.code)) {
    codeStr = e.code.toUpperCase().replace(/-/g, '_');
  }
  if (codeStr === null) return null;
  const message = typeof e.message === 'string' ? e.message : String(err);
  return { code: codeStr, message };
}

function numericCodeToString(code: number): string {
  switch (code) {
    case 4: return 'DEADLINE_EXCEEDED';
    case 7: return 'PERMISSION_DENIED';
    case 10: return 'ABORTED';
    case 14: return 'UNAVAILABLE';
    default: return `CODE_${code}`;
  }
}

/**
 * Run an RPC, returning the value on success or null on a classified error
 * (which is also pushed as an `error` event onto the events array).
 *
 * Any unrecognized error re-throws — only the codes in `RETRYABLE_*` are
 * tolerated. This keeps SDK-contract bugs (the 0.A class of failures) loud.
 */
async function safeRpc<T>(
  fn: () => Promise<T>,
  templatePath: string,
  events: DiscoverEvent[],
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    const classified = classifyRpcError(err);
    if (classified === null) throw err;
    events.push({
      kind: 'error',
      templatePath,
      code: classified.code,
      message: classified.message,
    });
    return null;
  }
}

// ─── BFS crawler ──────────────────────────────────────────────────────────

/**
 * Walk the Firestore tree breadth-first. Each layer issues its
 * `listDocuments` + per-doc `listCollections` calls in parallel under a
 * shared concurrency cap.
 *
 * Returns once every reachable collection (within `maxDepth`) is recorded.
 * The returned `discovered` map is keyed by templatePath; `events` is the
 * ordered event log emitted during the walk (currently only
 * `collection_discovered`).
 */
export async function crawlStructure(
  db: CrawlerFirestore,
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const rootFilter = options.rootFilter;

  const events: DiscoverEvent[] = [];
  const discovered = new Map<string, DiscoveredCollection>();
  let listOps = 0;

  // Layer 0 — root collections. A failure here means the agent has no
  // listCollections permission at the database root; emit `error` and
  // return an empty result rather than throwing.
  listOps++;
  const rootsResult = await safeRpc(() => db.listCollections(), '', events);
  let roots = rootsResult ?? [];
  if (rootFilter) {
    roots = roots.filter((c) => rootFilter(c.id));
  }
  for (const root of roots) {
    recordCollection(discovered, events, root, /* depth */ 0, /* parentPath */ undefined);
  }

  // BFS across layers. `frontier` always holds the collection refs entering
  // this layer; we expand each to the doc set, then per-doc subcollections,
  // and the union of new collection refs becomes the next frontier.
  let frontier: CrawlerCollectionRef[] = roots;
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    // Step 1: list docs of each collection in the layer (parallel, capped).
    // A per-collection failure surfaces as an `error` event and that
    // collection contributes zero docs to the layer.
    const docsByColl = await runWithLimit(frontier, maxConcurrency, async (coll) => {
      listOps++;
      const tpl = toTemplatePath(coll.path);
      const docs = await safeRpc(() => coll.listDocuments(), tpl, events);
      return docs ?? [];
    });

    // Attach docs to each frontier collection's discovered entry so the
    // sampling pass can draw from them without re-listing.
    for (let i = 0; i < frontier.length; i++) {
      const coll = frontier[i]!;
      const docs = docsByColl[i] ?? [];
      const tpl = toTemplatePath(coll.path);
      const entry = discovered.get(tpl);
      if (entry) entry.docRefs.push(...docs);
    }

    const allDocs = docsByColl.flat();
    if (allDocs.length === 0) {
      frontier = [];
      break;
    }

    // Step 2: list subcollections under each doc (parallel, capped). A
    // per-doc failure attributes to the parent collection's templatePath.
    const subsByDoc = await runWithLimit(allDocs, maxConcurrency, async (doc) => {
      listOps++;
      // Parent collection path = doc.path with last segment stripped.
      const parentCollPath = doc.path.slice(0, doc.path.lastIndexOf('/'));
      const tpl = parentCollPath ? toTemplatePath(parentCollPath) : '';
      const subs = await safeRpc(() => doc.listCollections(), tpl, events);
      return subs ?? [];
    });

    // Step 3: record + accumulate into next frontier.
    const next: CrawlerCollectionRef[] = [];
    for (let i = 0; i < allDocs.length; i++) {
      const parentDoc = allDocs[i]!;
      const subs = subsByDoc[i] ?? [];
      for (const sub of subs) {
        recordCollection(discovered, events, sub, depth + 1, parentDoc.path);
        next.push(sub);
      }
    }
    frontier = next;
  }

  return { events, discovered, listOps };
}

// ─── Sampling + merge integration (Item 2.3) ──────────────────────────────

/**
 * Full crawl: discover structure, then sample up to `maxSamples` docs per
 * discovered templatePath and feed them through the merge layer. Emits
 * `schema_updated` events for every non-empty merge and `sampling_complete`
 * once per templatePath.
 *
 * **Pause/resume (Item 4.2).** When a `SessionStore` is supplied, the
 * crawler measures the persisted-state size at two pause boundaries:
 *
 *   1. End of every BFS layer in the structure phase
 *   2. End of every templatePath in the sampling phase
 *
 * If the persisted state exceeds `maxBatchBytes` (default 1 MB), the
 * crawler persists state and returns a `continuation` token. The agent
 * resumes by passing `{ continuation }` on the next call. Counters
 * (`listOps`, `readOps`) are cumulative across batches; events are
 * per-batch only (agents accumulate them themselves).
 *
 * Without a `SessionStore`, the crawler runs to completion regardless of
 * size — single-call mode is unchanged.
 *
 * **Continuation lifecycle.** Continuation handles are minted/validated by
 * the supplied `SessionStore` (see `discover/session.ts`). Malformed,
 * expired, or evicted tokens surface as a single `error` event and an
 * otherwise-empty result — agents can re-issue without continuation
 * per the recovery hint.
 */
export async function crawl(
  db: CrawlerFirestore,
  options: CrawlOptions = {},
  sessions?: SessionStore<PersistedCrawlState>,
): Promise<FullCrawlResult> {
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
  const maxErrorsPerCollection =
    options.maxErrorsPerCollection ?? DEFAULT_MAX_ERRORS_PER_COLLECTION;
  const stopOnStable = options.stopOnStable ?? DEFAULT_STOP_ON_STABLE;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const rootFilter = options.rootFilter;
  const maxBatchBytes = options.maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES;
  const subtreeMultiplier =
    options.dryRunSubtreeMultiplier ?? DEFAULT_DRY_RUN_SUBTREE_MULTIPLIER;

  const events: DiscoverEvent[] = [];

  // ─── dryRun branch (Item 5.1) ───────────────────────────────────────
  // Issues exactly one RPC (root listCollections) and returns a heuristic
  // projection. No documents are read, no per-doc listCollections, no
  // sampling. Continuation pattern intentionally not supported — see the
  // dryRun JSDoc for the agent-semantics rationale.
  if (options.dryRun === true) {
    if (options.continuation !== undefined) {
      events.push({
        kind: 'error',
        templatePath: '',
        code: 'DRYRUN_NO_CONTINUATION',
        message:
          'dryRun: true does not accept a continuation token — it issues no real crawl. ' +
          'To resume a paused crawl, omit dryRun (or pass false).',
      });
      return emptyResult(events);
    }
    const rootsResult = await safeRpc(() => db.listCollections(), '', events);
    const allRoots = rootsResult ?? [];
    const filteredRoots = rootFilter ? allRoots.filter((c) => rootFilter(c.id)) : allRoots;
    const rootCollectionIds = filteredRoots.map((c) => c.id);
    for (const root of filteredRoots) {
      events.push({ kind: 'collection_discovered', templatePath: root.id, depth: 0 });
    }
    const rootCount = filteredRoots.length;
    const estimate: DryRunCostEstimate = {
      rootCollectionCount: rootCount,
      rootCollectionIds,
      maxSamples,
      subtreeMultiplier,
      estimatedListOps: 1 + rootCount * subtreeMultiplier,
      estimatedReadOps: rootCount * subtreeMultiplier * maxSamples,
    };
    return {
      events,
      discovered: new Map(),
      listOps: 1,
      readOps: 0,
      finalizedSchemas: new Map(),
      complete: true,
      dryRunCostEstimate: estimate,
    };
  }

  // ─── State acquisition: resume or init ──────────────────────────────
  let state: PersistedCrawlState;
  if (options.continuation !== undefined) {
    if (!sessions) {
      events.push({
        kind: 'error',
        templatePath: '',
        code: 'NO_SESSION_STORE',
        message: 'Continuation token provided but no SessionStore was passed to crawl().',
      });
      return emptyResult(events);
    }
    const lookup = sessions.get(options.continuation);
    if (!lookup.ok) {
      events.push(sessionErrorToEvent(lookup.error));
      return emptyResult(events);
    }
    state = lookup.value.state;
  } else {
    state = {
      phase: 'structure',
      currentDepth: 0,
      maxDepth,
      frontierPaths: [],
      discovered: {},
      samplingQueue: [],
      finalizedSchemas: {},
      listOps: 0,
      readOps: 0,
    };
  }

  // Hydrate the persisted view into in-memory refs. Done once per batch.
  const discovered = hydrateDiscovered(state.discovered, db);
  let frontier: CrawlerCollectionRef[] =
    state.phase === 'structure' && state.frontierPaths.length > 0
      ? state.frontierPaths.map((p) => requireCollection(db, p))
      : [];

  // ─── Structure phase ────────────────────────────────────────────────
  if (state.phase === 'structure') {
    // Layer 0 bootstrap: only on a brand-new crawl (no continuation).
    // Resumes never enter this branch — frontierPaths is restored.
    if (state.currentDepth === 0 && frontier.length === 0 && discovered.size === 0) {
      state.listOps++;
      const rootsResult = await safeRpc(() => db.listCollections(), '', events);
      let roots = rootsResult ?? [];
      if (rootFilter) roots = roots.filter((c) => rootFilter(c.id));
      for (const root of roots) {
        recordCollection(discovered, events, root, 0, undefined);
      }
      frontier = roots;
    }

    while (frontier.length > 0 && state.currentDepth < state.maxDepth) {
      const depth = state.currentDepth;

      // Step 1: list docs of each collection in this layer.
      const docsByColl = await runWithLimit(frontier, maxConcurrency, async (coll) => {
        state.listOps++;
        const tpl = toTemplatePath(coll.path);
        const docs = await safeRpc(() => coll.listDocuments(), tpl, events);
        return docs ?? [];
      });

      for (let i = 0; i < frontier.length; i++) {
        const coll = frontier[i]!;
        const docs = docsByColl[i] ?? [];
        const tpl = toTemplatePath(coll.path);
        const entry = discovered.get(tpl);
        if (entry) entry.docRefs.push(...docs);
      }

      const allDocs = docsByColl.flat();
      if (allDocs.length === 0) {
        frontier = [];
        state.currentDepth++;
        break;
      }

      // Step 2: list subcollections under each doc.
      const subsByDoc = await runWithLimit(allDocs, maxConcurrency, async (doc) => {
        state.listOps++;
        const parentCollPath = doc.path.slice(0, doc.path.lastIndexOf('/'));
        const tpl = parentCollPath ? toTemplatePath(parentCollPath) : '';
        const subs = await safeRpc(() => doc.listCollections(), tpl, events);
        return subs ?? [];
      });

      // Step 3: record + accumulate next frontier.
      const next: CrawlerCollectionRef[] = [];
      for (let i = 0; i < allDocs.length; i++) {
        const parentDoc = allDocs[i]!;
        const subs = subsByDoc[i] ?? [];
        for (const sub of subs) {
          recordCollection(discovered, events, sub, depth + 1, parentDoc.path);
          next.push(sub);
        }
      }
      frontier = next;
      state.currentDepth++;

      // Pause check: persisted-state size after this layer's work.
      // We rebuild the persisted view first so the measurement matches
      // what we'd actually store.
      state.frontierPaths = frontier.map((c) => c.path);
      state.discovered = serializeDiscovered(discovered);

      const pause = checkPause(state, sessions, maxBatchBytes);
      if (pause !== null) {
        return pauseAndPersist(pause, state, events, discovered, sessions!, options);
      }
    }

    // Structure phase complete; transition to sampling.
    state.phase = 'sampling';
    state.frontierPaths = [];
    state.samplingQueue = Array.from(discovered.keys()).filter(
      (tpl) => !(tpl in state.finalizedSchemas),
    );
  }

  // ─── Sampling phase ─────────────────────────────────────────────────
  while (state.samplingQueue.length > 0) {
    const tpl = state.samplingQueue[0]!;
    const entry = discovered.get(tpl);
    if (!entry) {
      // Defensive — shouldn't happen since samplingQueue is built from
      // discovered. Skip rather than throw.
      state.samplingQueue.shift();
      continue;
    }

    const { schema: finalizedSchema, readOps: tplReadOps } = await sampleOneTemplate(
      entry,
      { maxConcurrency, maxSamples, stopOnStable, maxErrorsPerCollection },
      events,
    );
    state.readOps += tplReadOps;

    // Build the CollectionSchema with subcollectionTemplatePaths populated
    // now (rather than as a final pass) — `discovered` is fixed once the
    // structure phase ends, so the subcollection set is knowable here.
    state.finalizedSchemas[tpl] = {
      templatePath: tpl,
      examplePath: entry.examplePath,
      schema: finalizedSchema.schema,
      samplingComplete: finalizedSchema.samplingComplete,
      declaredAt: finalizedSchema.declaredAt,
      subcollectionTemplatePaths: directChildTemplatePaths(tpl, discovered),
    };
    state.samplingQueue.shift();
    state.discovered = serializeDiscovered(discovered);

    if (state.samplingQueue.length > 0) {
      const pause = checkPause(state, sessions, maxBatchBytes);
      if (pause !== null) {
        return pauseAndPersist(pause, state, events, discovered, sessions!, options);
      }
    }
  }

  // ─── Crawl complete ─────────────────────────────────────────────────
  // Clean up the session if one was provided + we resumed at least once
  // (so the agent doesn't have a stale token). Best-effort.
  if (sessions && options.continuation) sessions.delete(options.continuation);

  const finalizedSchemas = new Map<string, CollectionSchema>();
  for (const [k, v] of Object.entries(state.finalizedSchemas)) {
    finalizedSchemas.set(k, v);
  }

  return {
    events,
    discovered,
    listOps: state.listOps,
    readOps: state.readOps,
    finalizedSchemas,
    complete: true,
  };
}

// ─── Per-template sampling helper ─────────────────────────────────────────

interface SampleOpts {
  maxConcurrency: number;
  maxSamples: number;
  stopOnStable: number;
  maxErrorsPerCollection: number;
}

interface TemplateSampleResult {
  schema: FieldSchema;
  samplingComplete: SamplingComplete;
  declaredAt: number | null;
}

/**
 * Sample one templatePath: read up to `maxSamples` docs in chunks of
 * `stopOnStable`, feed each through `mergeDoc`, classify the termination
 * via the 4-state enum. Returns the finalized schema bundle + the read
 * count so the caller can accumulate it onto the cumulative `readOps`.
 *
 * Emits `schema_updated`, `error`, and `sampling_complete` events into
 * the shared event list.
 */
async function sampleOneTemplate(
  entry: DiscoveredCollection,
  opts: SampleOpts,
  events: DiscoverEvent[],
): Promise<{ schema: TemplateSampleResult; readOps: number }> {
  const { maxConcurrency, maxSamples, stopOnStable, maxErrorsPerCollection } = opts;
  const capRefs = entry.docRefs.slice(0, maxSamples);
  const cappedByMax = entry.docRefs.length > maxSamples;

  let schema: FieldSchema = emptySchema();
  let errorsThisCollection = 0;
  let errorBudgetExhausted = false;
  let consecutiveStable = 0;
  let declaredAt: number | null = null;
  let earlyExitViaStable = false;
  let readOps = 0;

  const chunkSize = Math.max(1, stopOnStable);
  let i = 0;
  while (i < capRefs.length && !earlyExitViaStable && !errorBudgetExhausted) {
    const chunk = capRefs.slice(i, i + chunkSize);
    const snaps = await runWithLimit(chunk, maxConcurrency, async (ref) => {
      if (errorBudgetExhausted) return null;
      readOps++;
      try {
        return await ref.get();
      } catch (err) {
        const classified = classifyRpcError(err);
        if (classified === null) throw err;
        errorsThisCollection++;
        events.push({
          kind: 'error',
          templatePath: entry.templatePath,
          code: classified.code,
          message: classified.message,
        });
        if (errorsThisCollection >= maxErrorsPerCollection) {
          errorBudgetExhausted = true;
        }
        return null;
      }
    });

    for (const snap of snaps) {
      if (errorBudgetExhausted) break;
      if (snap === null) {
        i++;
        continue;
      }
      if (snap._fieldsProto === undefined || snap._fieldsProto === null) {
        i++;
        continue;
      }
      const { observations, reservedNames } = snapshotToObservations(snap);
      if (Object.keys(observations).length === 0) {
        i++;
        continue;
      }
      const { next, changes } = mergeDoc(schema, observations);
      for (const [k, reason] of Object.entries(reservedNames)) {
        const desc = next.fields[k];
        if (desc) desc.reservedReason = reason;
      }
      schema = next;
      if (changes.length > 0) {
        events.push({
          kind: 'schema_updated',
          templatePath: entry.templatePath,
          changes,
        });
        consecutiveStable = 0;
      } else {
        consecutiveStable++;
        if (declaredAt === null && consecutiveStable >= stopOnStable) {
          declaredAt = next.samplesSeen - 1;
          earlyExitViaStable = true;
        }
      }
      i++;
      if (earlyExitViaStable) break;
    }
  }

  const consumedAll = i >= capRefs.length;
  const samplingComplete: SamplingComplete = errorBudgetExhausted
    ? 'sampling_open'
    : earlyExitViaStable
      ? 'converged_via_stable'
      : consumedAll && !cappedByMax
        ? 'converged_via_exhausted'
        : 'converged_via_max';

  events.push({
    kind: 'sampling_complete',
    templatePath: entry.templatePath,
    samplingComplete,
    samplesSeen: schema.samplesSeen,
    declaredAt,
  });

  return {
    schema: { schema, samplingComplete, declaredAt },
    readOps,
  };
}

// ─── Persistence helpers (Item 4.2) ───────────────────────────────────────

function serializeDiscovered(
  map: Map<string, DiscoveredCollection>,
): Record<string, PersistedDiscoveredCollection> {
  const out: Record<string, PersistedDiscoveredCollection> = {};
  for (const [tpl, d] of map) {
    out[tpl] = {
      templatePath: d.templatePath,
      depth: d.depth,
      examplePath: d.examplePath,
      refPaths: d.refs.map((r) => r.path),
      docRefPaths: d.docRefs.map((r) => r.path),
    };
  }
  return out;
}

function hydrateDiscovered(
  record: Record<string, PersistedDiscoveredCollection>,
  db: CrawlerFirestore,
): Map<string, DiscoveredCollection> {
  const map = new Map<string, DiscoveredCollection>();
  for (const [tpl, p] of Object.entries(record)) {
    map.set(tpl, {
      templatePath: p.templatePath,
      depth: p.depth,
      examplePath: p.examplePath,
      refs: p.refPaths.map((rp) => requireCollection(db, rp)),
      docRefs: p.docRefPaths.map((dp) => requireDoc(db, dp)),
    });
  }
  return map;
}

function requireCollection(db: CrawlerFirestore, path: string): CrawlerCollectionRef {
  if (typeof db.collection !== 'function') {
    throw new Error(
      `Cannot resume crawl: db.collection(path) is required to reconstruct refs ` +
        `but the supplied Firestore does not implement it.`,
    );
  }
  return db.collection(path);
}

function requireDoc(db: CrawlerFirestore, path: string): CrawlerDocumentRef {
  if (typeof db.doc !== 'function') {
    throw new Error(
      `Cannot resume crawl: db.doc(path) is required to reconstruct refs ` +
        `but the supplied Firestore does not implement it.`,
    );
  }
  return db.doc(path);
}

/**
 * Returns `{ bytes }` if the crawl should pause now, else `null`.
 * Re-uses the same `JSON.stringify` work for both the threshold check
 * and the eventual `update`/`create` call so we don't serialize twice.
 */
function checkPause(
  state: PersistedCrawlState,
  sessions: SessionStore<PersistedCrawlState> | undefined,
  maxBatchBytes: number,
): { bytes: number; serialized: string } | null {
  if (!sessions) return null;
  const serialized = JSON.stringify(state);
  const bytes = serialized.length;
  if (bytes < maxBatchBytes) return null;
  return { bytes, serialized };
}

function pauseAndPersist(
  pause: { bytes: number; serialized: string },
  state: PersistedCrawlState,
  events: DiscoverEvent[],
  discovered: Map<string, DiscoveredCollection>,
  sessions: SessionStore<PersistedCrawlState>,
  options: CrawlOptions,
): FullCrawlResult {
  // Reuse-or-create: if the agent passed a continuation, keep the same
  // session id (so the agent's existing handle stays valid). Otherwise
  // mint a fresh session.
  let token: string;
  if (options.continuation !== undefined) {
    const r = sessions.update(options.continuation, state, pause.bytes);
    if (!r.ok) {
      events.push(sessionErrorToEvent(r.error));
      return emptyResult(events);
    }
    token = r.value.token;
  } else {
    const r = sessions.create(state, pause.bytes);
    if (!r.ok) {
      events.push(sessionErrorToEvent(r.error));
      return emptyResult(events);
    }
    token = r.value.token;
  }

  const finalizedSchemas = new Map<string, CollectionSchema>();
  for (const [k, v] of Object.entries(state.finalizedSchemas)) {
    finalizedSchemas.set(k, v);
  }

  return {
    events,
    discovered,
    listOps: state.listOps,
    readOps: state.readOps,
    finalizedSchemas,
    continuation: token,
    complete: false,
  };
}

function sessionErrorToEvent(err: SessionError): DiscoverEvent {
  return {
    kind: 'error',
    templatePath: '',
    code: err.code,
    message: `${err.message} (recoveryHint: ${err.recoveryHint})`,
  };
}

function emptyResult(events: DiscoverEvent[]): FullCrawlResult {
  return {
    events,
    discovered: new Map(),
    listOps: 0,
    readOps: 0,
    finalizedSchemas: new Map(),
    complete: true,
  };
}

function directChildTemplatePaths(
  parentTpl: string,
  discovered: Map<string, DiscoveredCollection>,
): string[] {
  const prefix = parentTpl + '/';
  const out: string[] = [];
  for (const tpl of discovered.keys()) {
    if (!tpl.startsWith(prefix)) continue;
    const tail = tpl.slice(prefix.length);
    if (tail.split('/').length === 2) out.push(tpl); // {docId}/childColl
  }
  return out;
}

/**
 * Emit `collection_discovered` once per distinct templatePath, but
 * accumulate all concrete refs (so Item 2.3 can sample across every
 * concrete instance of a template, not just the first one encountered).
 */
function recordCollection(
  discovered: Map<string, DiscoveredCollection>,
  events: DiscoverEvent[],
  ref: CrawlerCollectionRef,
  depth: number,
  parentPath: string | undefined,
): void {
  const templatePath = toTemplatePath(ref.path);
  const existing = discovered.get(templatePath);
  if (existing) {
    existing.refs.push(ref);
    return;
  }
  discovered.set(templatePath, {
    templatePath,
    depth,
    examplePath: ref.path,
    refs: [ref],
    docRefs: [],
  });
  const event: DiscoverEvent = parentPath
    ? { kind: 'collection_discovered', templatePath, depth, parentPath }
    : { kind: 'collection_discovered', templatePath, depth };
  events.push(event);
}
