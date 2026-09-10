/**
 * The composite index definitions a set of queries require, in
 * `firestore.indexes.json` shape.
 *
 * The design asks for this over the sandbox's recorded queries when none are
 * supplied. The sandbox does not keep a structured log of a query's
 * collection, filters, and orderings today, only the rules-decision events
 * `sandbox.events` pages, so `queries` is the call's own list until that log
 * exists; an empty call reports that honestly rather than guessing. Detection
 * itself reuses the same composite-index rule the source-text extractor uses
 * (`pyric/rules/internal`'s `needsCompositeIndex` / `shapeToIndexEntry`), over
 * a `QueryShape` built straight from the call's arguments instead of parsed
 * from source.
 */
import { z } from 'zod';
import { indexEntryKey, needsCompositeIndex, shapeToIndexEntry } from 'pyric/rules/internal';
import type { IndexesConfigEntry } from 'pyric/rules/internal';
import { indexQuery, queryShapeOf } from '../../arguments/firestore.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'extractIndexes',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'extractIndexes(queries?[{path, constraints?[asc|desc]}])',
  description: 'Find indexes a set of queries need.',
  args: z.object({
    queries: z
      .array(indexQuery)
      .optional()
      .describe('Queries to check. Omit to check none: the sandbox keeps no query log yet.'),
  }),
  operation: 'extract_firestore_indexes',
  example: {
    queries: [
      {
        path: 'orders',
        constraints: [
          { type: 'where', field: 'status', op: '==', value: 'paid' },
          { type: 'orderBy', field: 'createdAt', direction: 'desc' },
        ],
      },
    ],
  },
  async handler(args) {
    const queries = Array.isArray(args.queries) ? (args.queries as Record<string, unknown>[]) : [];
    const byKey = new Map<string, IndexesConfigEntry>();
    for (const entry of queries) {
      const shape = queryShapeOf(entry);
      if (!needsCompositeIndex(shape)) continue;
      const index = shapeToIndexEntry(shape);
      byKey.set(indexEntryKey(index), index);
    }
    const indexes = [...byKey.values()];
    const summary =
      queries.length === 0
        ? 'No queries were supplied, so no index requirement is known.'
        : `${indexes.length} composite index(es) required by ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}.`;
    return { ok: true, summary, data: { indexes, fieldOverrides: [] } };
  },
} satisfies MethodRecord;
