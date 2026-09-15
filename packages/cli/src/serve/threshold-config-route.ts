import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectBody } from '../bridge/server/peer.js';
import type { ThresholdConfigStore } from './threshold-config-store.js';
import { readThresholdConfig } from './runtime/rate-threshold-config.js';

/** Namespace host, origin, and session checks must run before this handler. */
export async function handleThresholdConfig(store: ThresholdConfigStore, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') { res.end(JSON.stringify(await store.read())); return true; }
    if (req.method !== 'PUT') { res.statusCode = 405; res.end(JSON.stringify({ error: 'Method not allowed' })); return true; }
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Send threshold settings as JSON.');
    const input = await collectBody(req, 16 * 1024) as { config?: unknown; revision?: unknown };
    if (!input || typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || input.config === undefined) throw new Error('Load threshold settings before saving.');
    res.end(JSON.stringify(await store.save(readThresholdConfig(input.config), input.revision)));
  } catch (error) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to save threshold settings.' }));
  }
  return true;
}
