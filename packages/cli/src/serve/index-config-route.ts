import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { collectBody } from '../bridge/server/peer.js';
import type { IndexConfigStore } from './index-config-store.js';

const firestoreQuerySchema = z.object({
  collectionGroup: z.string().min(1).max(1500).refine(value => !value.includes('/')),
  queryScope: z.enum(['COLLECTION', 'COLLECTION_GROUP']),
  filters: z.array(z.object({ field: z.string().min(1).max(1500), op: z.string().max(24) })).max(64),
  orders: z.array(z.object({ field: z.string().min(1).max(1500), direction: z.enum(['asc', 'desc']) })).max(64),
  unsupported: z.string().max(200).optional(),
});

const databaseQuerySchema = z.object({ service: z.literal('rtdb'), path: z.string().min(1).max(2048), orderBy: z.union([z.object({ kind: z.literal('child'), path: z.string().min(1).max(2048) }), z.object({ kind: z.enum(['key', 'value', 'priority']) })]).nullable() });
const querySchema = z.union([firestoreQuerySchema, databaseQuerySchema]);

/** Called only after the namespace's host, origin and capability checks. */
export async function handleIndexConfig(store: IndexConfigStore, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') { res.end(JSON.stringify(await store.read(new URL(req.url ?? '/', 'http://localhost').searchParams.get('service') === 'rtdb' ? 'rtdb' : 'firestore'))); return true; }
    if (req.method !== 'POST' && req.method !== 'PUT') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return true; }
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Send a JSON index request.');
    const input = z.object({ query: querySchema, revision: z.string().length(64).optional() }).parse(await collectBody(req, 64 * 1024));
    if (req.method === 'PUT' && !input.revision) throw new Error('Preview the index change before applying it.');
    res.end(JSON.stringify(req.method === 'PUT' ? await store.apply(input.query, input.revision!) : await store.preview(input.query)));
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to read the index configuration.' }));
  }
  return true;
}
