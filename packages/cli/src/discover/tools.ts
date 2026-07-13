/**
 * `createFirestoreDiscoverTools({ resolveDb })` — `ToolHandler[]` for
 * the discover-paths feature, browser-safe (no firebase-admin import).
 *
 * Two handlers:
 *   - `firestore_discover_paths` — BFS sample every collection
 *     reachable from the root, return per-templatePath schema +
 *     cost counters. Supports `dryRun` cost preview and
 *     `continuation` resume.
 *   - `firestore_find_collection_group` — bounded
 *     `collectionGroup(id).select().limit(N).get()` to answer "where
 *     does collection ID X appear?".
 *
 * Session lifetime: per-factory-call. Each `createFirestoreDiscoverTools`
 * invocation creates its own `SessionStore` for continuation tokens.
 * Per the in-progress agents work, a single agent process should
 * therefore reuse one factory instance for the duration of a session.
 *
 * Per F2 / F4: identity is a value (the resolver), lifecycle is
 * per-dispatch. `resolveDb()` runs inside each tool execute so hosts
 * can swap the underlying CrawlerFirestore (e.g. admin → sandbox)
 * between calls without re-wiring.
 *
 * Output shape: `crawl()`'s native `finalizedSchemas: Map<...>` flattens
 * to a `schemas: Record<templatePath, ...>` shape for JSON
 * serialization across the tool boundary. `discovered` (raw refs) is
 * dropped — agents consume the finalized schemas.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { crawl, type FullCrawlResult } from './crawler.js';
import { findCollectionGroup } from './findCollectionGroup.js';
import { SessionStore } from './session.js';
import type { PersistedCrawlState } from './crawler.js';
import type { CollectionSchema, DiscoverEvent } from './types.js';
import type {
  CollectionGroupCapableFirestore,
  CrawlerFirestore,
} from './firestore-source.js';

export interface FirestoreDiscoverToolDeps {
  /**
   * Resolver returning the CrawlerFirestore to scan. Called per
   * dispatch (F4). For `firestore_find_collection_group` the returned
   * Firestore must also satisfy {@link CollectionGroupCapableFirestore}.
   */
  resolveDb(): CrawlerFirestore & CollectionGroupCapableFirestore;
}

/** JSON-serializable shape returned by `firestore_discover_paths`. */
export interface DiscoverPathsToolResult {
  /** Per-templatePath finalized schemas, keyed by templatePath. */
  schemas: Record<string, CollectionSchema>;
  events: DiscoverEvent[];
  /** `listCollections` + `listDocuments` calls — cumulative across batches. */
  listOps: number;
  /** `.get()` calls during sampling — cumulative across batches. */
  readOps: number;
  /** Opaque resume handle iff the crawl paused at a payload boundary. */
  continuation?: string;
  /** True iff the crawl finished. Equivalent to `continuation === undefined`. */
  complete: boolean;
  /** Present iff this was a `dryRun: true` preview. */
  dryRunCostEstimate?: FullCrawlResult['dryRunCostEstimate'];
}

interface DiscoverPathsArgs {
  maxDepth?: number;
  maxConcurrency?: number;
  maxSamples?: number;
  stopOnStable?: number;
  maxBatchBytes?: number;
  rootPrefix?: string;
  dryRun?: boolean;
  dryRunSubtreeMultiplier?: number;
  continuation?: string;
}

interface FindCollectionGroupArgs {
  collectionId: string;
  limit?: number;
}

export function createFirestoreDiscoverTools(
  deps: FirestoreDiscoverToolDeps,
): ToolHandler[] {
  const { resolveDb } = deps;
  // Per-factory session store — see header note on lifetime.
  const sessions = new SessionStore<PersistedCrawlState>();

  return [
    {
      name: 'firestore_discover_paths',
      description:
        'Sample every collection reachable from the database root and return per-templatePath schemas (field types, presence, enums, examples) plus discovered subcollection paths. Use this to understand a Firestore database\'s shape before generating client code, security rules, or analytics queries. ' +
        'Cost is bounded: structure walk is one listCollections/listDocuments per collection; sampling is min(maxSamples, available) per templatePath with adaptive early-exit. Cumulative cost is reported as listOps + readOps. ' +
        'Set dryRun: true for an informational cost preview that issues exactly one root listCollections RPC and returns a heuristic projection — no documents are read. Large databases pause at payload boundaries and return a continuation token; pass it back as the next call\'s continuation to resume.',
      parameters: {
        type: 'object',
        properties: {
          maxDepth: { type: 'integer', minimum: 1, description: 'Max BFS depth from root collections. Default 10 — runaway guard.' },
          maxConcurrency: { type: 'integer', minimum: 1, description: 'In-flight RPC cap. Default 32.' },
          maxSamples: { type: 'integer', minimum: 1, description: 'Hard cap on docs sampled per templatePath. Default 50.' },
          stopOnStable: { type: 'integer', minimum: 1, description: 'Adaptive early-exit: stop sampling a templatePath after this many consecutive no-change merges. Default 8. Set higher than maxSamples to disable.' },
          maxBatchBytes: { type: 'integer', minimum: 1024, description: 'Pause when persisted state exceeds this many bytes. Default 1 MB. Only effective when continuations are in play.' },
          rootPrefix: { type: 'string', description: 'Restrict the crawl to root collections whose ID starts with this prefix.' },
          dryRun: { type: 'boolean', description: 'Cost-preview mode. Issues exactly one root listCollections RPC and returns a heuristic projection. No documents are read. Cannot be combined with a continuation token.' },
          dryRunSubtreeMultiplier: { type: 'integer', minimum: 1, description: 'Multiplier in the dryRun projection: roots × this = projected total collections. Default 3 (conservative).' },
          continuation: { type: 'string', description: 'Resume a paused crawl. Use the continuation token from a prior result. Pass nothing to start fresh.' },
        },
      },
      async execute(args) {
        const params = (args ?? {}) as DiscoverPathsArgs;
        try {
          const db = resolveDb();
          const rootFilter = params.rootPrefix
            ? (id: string) => id.startsWith(params.rootPrefix!)
            : undefined;
          const result = await crawl(
            db,
            {
              maxDepth: params.maxDepth,
              maxConcurrency: params.maxConcurrency,
              maxSamples: params.maxSamples,
              stopOnStable: params.stopOnStable,
              maxBatchBytes: params.maxBatchBytes,
              rootFilter,
              dryRun: params.dryRun,
              dryRunSubtreeMultiplier: params.dryRunSubtreeMultiplier,
              continuation: params.continuation,
            },
            sessions,
          );
          const schemas: Record<string, CollectionSchema> = {};
          for (const [templatePath, schema] of result.finalizedSchemas) {
            schemas[templatePath] = schema;
          }
          const data: DiscoverPathsToolResult = {
            schemas,
            events: result.events,
            listOps: result.listOps,
            readOps: result.readOps,
            complete: result.complete,
            ...(result.continuation !== undefined && { continuation: result.continuation }),
            ...(result.dryRunCostEstimate !== undefined && {
              dryRunCostEstimate: result.dryRunCostEstimate,
            }),
          };
          return {
            ok: true,
            summary: `Discovered ${Object.keys(schemas).length} template path(s); ${result.readOps} read(s), ${result.listOps} list(s)${result.complete ? '' : ' — paused, resume with continuation'}`,
            data,
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            summary: `firestore_discover_paths failed: ${message}`,
            data: { success: false, error: { code: 'DISCOVER_FAILED', message, recoverable: false } },
          };
        }
      },
    },

    {
      name: 'firestore_find_collection_group',
      description:
        'Find every collection-group host of a given collection ID. Answers "where does collection ID X appear in the database?" by issuing one collectionGroup(id).select().limit(N).get() — cost is exactly N reads (default 100). ' +
        'Returns hosts in template-path form (e.g. users/{userId}/posts) with the per-host sampleDocCount from the N-doc draw. Coverage of all hosts is statistical: with K hosts, N=100 covers ~22 distinct hosts with high confidence (coupon-collector). The result\'s limitWasReached flag signals whether to raise the cap. ' +
        'Use this as a cold-start alternative to firestore_discover_paths when you already know the collection ID and just need the parent paths.',
      parameters: {
        type: 'object',
        properties: {
          collectionId: { type: 'string', minLength: 1, description: 'The leaf collection ID to find (e.g. "posts", "moves").' },
          limit: { type: 'integer', minimum: 1, description: 'Max docs to fetch from the collection group. Default 100. Each doc costs one read; raise this if limitWasReached is true and you suspect more hosts.' },
        },
        required: ['collectionId'],
      },
      async execute(args) {
        const params = args as FindCollectionGroupArgs;
        try {
          const db = resolveDb();
          const result = await findCollectionGroup(db, params.collectionId, {
            limit: params.limit,
          });
          return {
            ok: true,
            summary: `Found ${result.hosts.length} host(s) for '${params.collectionId}'${result.limitWasReached ? ' (limit reached — raise to find more)' : ''}`,
            data: result,
          };
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return {
            ok: false,
            summary: `firestore_find_collection_group failed: ${message}`,
            data: { success: false, error: { code: 'FIND_COLLECTION_GROUP_FAILED', message, recoverable: false } },
          };
        }
      },
    },
  ];
}
