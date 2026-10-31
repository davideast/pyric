import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerAndClose, BODY_TOO_LARGE_CODE, collectBody } from '../bridge/server/peer.js';
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
    const isError = error instanceof Error;
    const body = JSON.stringify({ error: isError ? error.message : 'Unable to save threshold settings.' });
    const tooLarge = isError && 'code' in error && error.code === BODY_TOO_LARGE_CODE;
    if (tooLarge) {
      answerAndClose(req, res, 413, {}, body);
      return true;
    }
    res.statusCode = 400;
    res.end(body);
  }
  return true;
}
