/**
 * The collection and document paths the sandbox actually holds, walked from
 * its own document index rather than sampled.
 *
 * `pyric/sandbox/firestore`'s `snapshotDocuments` already returns every
 * document keyed by its full path, which is the sandbox's document index, so
 * a nesting level and a per-collection count fall out of grouping those keys
 * rather than crawling collections one `listCollections` RPC at a time. That
 * makes this exhaustive rather than sampled: every count is the real count,
 * not an estimate.
 */
import { z } from 'zod';
import { snapshotDocuments } from 'pyric/sandbox/firestore';
import {
  assertDeclaredFirestoreDatabase,
  checkFirestoreDatabase,
  databaseArgument,
  firestoreDatabaseSelector,
  onFirestoreDatabase,
} from '../../firestore-database.js';
import type { MethodRecord } from '../../method-types.js';

const DEFAULT_DEPTH = 5;
const DEFAULT_LIMIT = 200;

/** A document's path segments. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** How deeply nested a document's own collection is: 1 for a root collection. */
function collectionNestingLevel(documentPath: string): number {
  return segmentsOf(documentPath).length / 2;
}

/** The collection path one document lives directly under. */
function collectionOf(documentPath: string): string {
  const segments = segmentsOf(documentPath);
  return segments.slice(0, -1).join('/');
}

interface CollectionSummary {
  path: string;
  documentCount: number;
}

export default {
  tool: 'firestore',
  method: 'discoverPaths',
  runsIn: 'sandbox',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'discoverPaths(depth?, limit?, database?)',
  description: 'List paths present in the sandbox, with per-collection counts.',
  args: z.object({
    depth: z
      .number()
      .optional()
      .describe('Deepest collection nesting level to include. Default 5.'),
    limit: z
      .number()
      .optional()
      .describe('Maximum document paths to list. Default 200. Collection counts are never truncated.'),
    database: databaseArgument,
  }),
  operation: 'discover_firestore_paths',
  example: { depth: 2, limit: 200 },
  validate: (args, { fail }) => checkFirestoreDatabase(args, fail),
  async handler(args, ctx) {
    const selector = firestoreDatabaseSelector(args.database);
    assertDeclaredFirestoreDatabase(ctx, selector);
    let depth = DEFAULT_DEPTH;
    if (typeof args.depth === 'number') {
      depth = args.depth;
    }
    let limit = DEFAULT_LIMIT;
    if (typeof args.limit === 'number') {
      limit = args.limit;
    }
    const documents = snapshotDocuments(ctx.sandbox, selector);
    const inScope = Object.keys(documents)
      .filter((path) => collectionNestingLevel(path) <= depth)
      .sort();

    const counts = new Map<string, number>();
    for (const path of inScope) {
      const collectionPath = collectionOf(path);
      counts.set(collectionPath, (counts.get(collectionPath) ?? 0) + 1);
    }
    const collections: CollectionSummary[] = [...counts.entries()]
      .map(([path, documentCount]) => ({ path, documentCount }))
      .sort((a, b) => a.path.localeCompare(b.path));

    const truncated = inScope.length > limit;
    const documentPaths = inScope.slice(0, limit);
    let baseSummary = `${collections.length} collection(s) to depth ${depth}, ${documentPaths.length} document(s).`;
    if (truncated) {
      baseSummary = `${collections.length} collection(s) to depth ${depth}, showing ${documentPaths.length} of ${inScope.length} document(s) (truncated by limit ${limit}).`;
    }

    return {
      ok: true,
      summary: onFirestoreDatabase(baseSummary, selector),
      data: { depth, limit, collections, documents: documentPaths, truncated },
    };
  },
} satisfies MethodRecord;
