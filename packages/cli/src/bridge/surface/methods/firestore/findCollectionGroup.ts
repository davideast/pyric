/**
 * Every collection path whose last segment is one collection id, wherever it
 * is nested, with the real document count each one holds.
 *
 * Every collection in the sandbox has at least one document (Firestore has no
 * empty collections), so grouping `snapshotDocuments`' document paths by
 * their immediate parent already enumerates every collection that exists,
 * exhaustively rather than by sampling a collectionGroup query.
 */
import { z } from 'zod';
import { snapshotDocuments } from 'pyric/sandbox/firestore';
import { quoted } from '../../closest-name.js';
import type { InvalidArguments, MethodRecord } from '../../method-types.js';

/** A document's path segments. */
function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** The collection path one document lives directly under. */
function collectionOf(documentPath: string): string {
  return segmentsOf(documentPath).slice(0, -1).join('/');
}

interface HostSummary {
  path: string;
  documentCount: number;
}

export default {
  tool: 'firestore',
  method: 'findCollectionGroup',
  sdkOrigin: 'pyric',
  effect: 'read',
  signature: 'findCollectionGroup(collectionId)',
  description: 'Find collection paths ending in one id.',
  args: z.object({
    collectionId: z.string().describe('The collection id to search for, for example comments.'),
  }),
  operation: 'find_firestore_collection_group',
  example: { collectionId: 'comments' },
  validate: (args, { fail }): InvalidArguments | null => {
    const id = args.collectionId;
    if (typeof id === 'string' && id.length > 0) return null;
    return fail(
      `collectionId is ${quoted(id)}, which is not a collection id.`,
      'Pass collectionId as a non-empty collection id.',
      'collectionId',
    );
  },
  async handler(args, ctx) {
    const collectionId = String(args.collectionId);
    const documents = snapshotDocuments(ctx.sandbox);
    const counts = new Map<string, number>();
    for (const path of Object.keys(documents)) {
      const collectionPath = collectionOf(path);
      counts.set(collectionPath, (counts.get(collectionPath) ?? 0) + 1);
    }
    const hosts: HostSummary[] = [...counts.entries()]
      .filter(([path]) => segmentsOf(path).at(-1) === collectionId)
      .map(([path, documentCount]) => ({ path, documentCount }))
      .sort((a, b) => a.path.localeCompare(b.path));

    return {
      ok: true,
      summary: `'${collectionId}' appears as ${hosts.length} collection(s).`,
      data: { collectionId, hosts },
    };
  },
} satisfies MethodRecord;
