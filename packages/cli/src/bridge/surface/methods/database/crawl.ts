/**
 * A bounded structural view of the Realtime Database tree: child names and
 * counts, with no leaf values, over the same implementation the
 * `rtdb_crawl_structure` bridge tool uses. That tool stays on the transport
 * surface for a browser-sandbox peer; this method reaches the identical
 * function so the two never drift, at the cost of the same crawl now living
 * behind two entry points.
 */
import { z } from 'zod';
import { snapshotState } from 'pyric/sandbox/database';
import { countDescendantObjects, crawlSnapshot } from '../../../../rtdb/crawl-snapshot.js';
import type { MethodRecord } from '../../method-types.js';

/** The deepest a crawl may descend, and the default when depth is omitted. */
const DEFAULT_DEPTH = 10;
const MAX_DEPTH = 10;

export default {
  tool: 'database',
  method: 'crawl',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: `crawl(path?, depth? = ${DEFAULT_DEPTH}, maximum ${MAX_DEPTH})`,
  description:
    'Bounded structural view of the tree at path: child names and object counts, with no leaf values. depth defaults to 10 and cannot exceed 10; a subtree deeper than depth is reported truncated rather than expanded.',
  args: z.object({
    path: z.string().optional().describe('Root-relative path to inspect. Defaults to the tree root.'),
    depth: z
      .number()
      .int()
      .min(0)
      .max(MAX_DEPTH)
      .optional()
      .describe(`Maximum object depth to return, 0 to ${MAX_DEPTH}. Defaults to ${DEFAULT_DEPTH}.`),
  }),
  operation: 'crawl_database_structure',
  example: { path: 'rooms', depth: 2 },
  async handler(args, ctx) {
    const options: { path?: string; maxDepth?: number } = {};
    if (args.path !== undefined) options.path = String(args.path);
    options.maxDepth = args.depth === undefined ? DEFAULT_DEPTH : Number(args.depth);
    const root = crawlSnapshot(snapshotState(ctx.sandbox), options);
    return {
      ok: true,
      summary: `Crawled ${countDescendantObjects(root)} object paths from ${root.path}`,
      data: root,
    };
  },
} satisfies MethodRecord;
