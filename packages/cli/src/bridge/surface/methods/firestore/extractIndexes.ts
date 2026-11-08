/**
 * The composite index definitions a set of queries or TypeScript/JavaScript
 * source paths require, in `firestore.indexes.json` shape.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { indexEntryKey, needsCompositeIndex, shapeToIndexEntry } from 'pyric/rules/internal';
import type { IndexesConfigEntry } from 'pyric/rules/internal';
import { ExtractFirestoreIndexesHandler } from 'pyric/rules/internal/extract';
import { indexQuery, queryShapeOf } from '../../arguments/firestore.js';
import { realProjectPathWithin } from '../../arguments/project-real-path.js';
import { failFor } from '../../method-validation.js';
import type { MethodRecord } from '../../method-types.js';

export default {
  tool: 'firestore',
  method: 'extractIndexes',
  runsIn: 'bridge',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'extractIndexes(queries?[{path, constraints?[asc|desc]}], paths?[])',
  description: 'Find indexes queries or source paths need.',
  args: z.object({
    queries: z
      .array(indexQuery)
      .optional()
      .describe('Queries to check. Omit when scanning source paths.'),
    paths: z
      .array(z.string())
      .optional()
      .describe('Source files or directories inside the project directory to scan.'),
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
  async handler(args, ctx) {
    const fail = failFor('firestore', 'extractIndexes');
    let queries: Record<string, unknown>[] = [];
    if (Array.isArray(args.queries)) {
      queries = args.queries as Record<string, unknown>[];
    }

    let rawPaths: string[] = [];
    if (Array.isArray(args.paths)) {
      rawPaths = args.paths as string[];
    }

    const resolvedPaths: string[] = [];
    for (const entry of rawPaths) {
      const resolved = realProjectPathWithin(ctx.projectDir, entry, 'paths', fail);
      if (!('path' in resolved)) return resolved;
      if (!existsSync(resolved.path)) {
        return {
          ok: false,
          summary: `firestore.extractIndexes: path '${entry}' does not exist inside the project directory.`,
        };
      }
      resolvedPaths.push(resolved.path);
    }

    const byKey = new Map<string, IndexesConfigEntry>();
    for (const entry of queries) {
      const shape = queryShapeOf(entry);
      if (!needsCompositeIndex(shape)) continue;
      const index = shapeToIndexEntry(shape);
      if (index.fields.length < 2) continue;
      byKey.set(indexEntryKey(index), index);
    }

    if (resolvedPaths.length > 0) {
      const extracted = new ExtractFirestoreIndexesHandler().execute({
        paths: resolvedPaths,
        projectDir: ctx.projectDir,
      });
      if (!extracted.success) {
        return { ok: false, summary: `firestore.extractIndexes: ${extracted.error.message}` };
      }
      for (const index of extracted.data.config.indexes) {
        byKey.set(indexEntryKey(index), index);
      }
      const indexes = [...byKey.values()];
      return {
        ok: true,
        summary: `${indexes.length} composite index(es) extracted.`,
        data: {
          indexes,
          fieldOverrides: [],
          warnings: extracted.data.warnings,
          signals: extracted.data.signals,
        },
      };
    }

    const indexes = [...byKey.values()];
    let summary = 'No queries were supplied, so no index requirement is known.';
    if (queries.length > 0) {
      const noun = queries.length === 1 ? 'query' : 'queries';
      summary = `${indexes.length} composite index(es) required by ${queries.length} ${noun}.`;
    }
    return { ok: true, summary, data: { indexes, fieldOverrides: [] } };
  },
} satisfies MethodRecord;
