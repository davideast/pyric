/**
 * `firestore_find_collection_group` — answers "where does collection ID
 * X appear in the database?"
 *
 * Item 6.1 lands this; locked Strategy A from the 0.H v1 scope (see plan
 * 0.H and Item 6). The tool exists for the cold-start case — agents
 * who already ran `discover_paths` can filter the discovered map
 * themselves. So this implementation is intentionally standalone.
 *
 * **Cost contract — bounded, statistical:**
 *
 * One query per call:
 *   `db.collectionGroup(id).select().limit(N).get()`
 *
 * Cost: exactly `min(N, totalDocsInGroup)` reads (1 per doc, regardless
 * of host count). Coverage of all hosts is statistical: with K hosts and
 * uniform doc distribution, P(all K covered | N draws) ≈ 1 once
 * `N ≥ K × ln(K)` (coupon-collector). Default `N = 100` covers ~22
 * distinct hosts with high confidence. The tool returns
 * `limitWasReached` so agents can raise the cap when they suspect
 * additional hosts.
 *
 * **What this tool is NOT:**
 *   - Not exhaustive — bounded by `limit`. To go exhaustive, raise
 *     `limit` until `limitWasReached === false`.
 *   - Not a host-doc-count — `sampleDocCount` is the number of returned
 *     docs that shared each parent path, not the host's total doc count.
 *   - Not a schema discovery tool — for that, use `discover_paths`.
 */
'use strict';

import { toTemplatePath } from './crawler.js';
import type { CollectionGroupCapableFirestore } from './firestore-source.js';

// ─── Tool surface ────────────────────────────────────────────────────────

export interface FindCollectionGroupOptions {
  /**
   * Max docs to fetch from the collection group. Default 100 — covers
   * ~22 distinct hosts with high confidence per the coupon-collector
   * heuristic. Raise this if the result reports `limitWasReached: true`
   * and you suspect more hosts exist.
   */
  limit?: number;
}

export interface FindCollectionGroupHost {
  /** Template-form parent collection path, e.g. `users/{userId}/posts`. */
  templatePath: string;
  /**
   * Number of docs in the N-doc draw that shared this parent path.
   * NOT the host's total doc count — that's a separate query.
   */
  sampleDocCount: number;
}

export interface FindCollectionGroupResult {
  /** Discovered hosts, deduped by templatePath. Order is insertion order
   *  (i.e. the order in which the first matching doc surfaced). */
  hosts: FindCollectionGroupHost[];
  /** Total docs read — the cost line item. Always `min(limit, totalDocsInGroup)`. */
  reads: number;
  /**
   * True iff `reads === limit`, signaling the agent should consider
   * raising `limit` if they need exhaustive host coverage.
   */
  limitWasReached: boolean;
}

const DEFAULT_LIMIT = 100;

/**
 * Find every collection-group host of a given collection ID.
 *
 * One read per returned doc — cost is bounded by `limit` (default 100).
 * Returns the hosts in template-path form (e.g. `users/{userId}/posts`)
 * with the per-host sample doc count.
 *
 * Throws on Admin SDK errors (network / permission). The tool is
 * standalone — no session, no continuation, no events — so error
 * propagation is straightforward.
 */
export async function findCollectionGroup(
  db: CollectionGroupCapableFirestore,
  collectionId: string,
  options: FindCollectionGroupOptions = {},
): Promise<FindCollectionGroupResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;

  if (typeof collectionId !== 'string' || collectionId.length === 0) {
    throw new Error('findCollectionGroup: collectionId must be a non-empty string');
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(
      `findCollectionGroup: limit must be a positive integer, got ${limit}`,
    );
  }

  const snap = await db.collectionGroup(collectionId).select().limit(limit).get();
  const docs = snap.docs;

  // Dedup parent paths in insertion order. Keys are concrete paths;
  // template conversion happens after dedup so we don't redo the work
  // per doc.
  const concreteCounts = new Map<string, number>();
  for (const d of docs) {
    const concretePath = d.ref.parent.path;
    concreteCounts.set(concretePath, (concreteCounts.get(concretePath) ?? 0) + 1);
  }

  // Map concrete → template, accumulating sampleDocCount across concrete
  // paths that map to the same templatePath. Two host instances of
  // `users/{userId}/posts` (e.g. `users/uid_1/posts` + `users/uid_2/posts`)
  // collapse into one host entry with summed counts.
  const templateCounts = new Map<string, number>();
  for (const [concretePath, count] of concreteCounts) {
    const tpl = toTemplatePath(concretePath);
    templateCounts.set(tpl, (templateCounts.get(tpl) ?? 0) + count);
  }

  const hosts: FindCollectionGroupHost[] = [];
  for (const [templatePath, sampleDocCount] of templateCounts) {
    hosts.push({ templatePath, sampleDocCount });
  }

  return {
    hosts,
    reads: docs.length,
    limitWasReached: docs.length === limit,
  };
}
