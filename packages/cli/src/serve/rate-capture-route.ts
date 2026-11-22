import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerAndClose, collectRawBody, isBodyTooLarge } from '../bridge/server/peer.js';
import type { RateCaptureStore } from './rate-capture-store.js';

export const RATE_CAPTURE_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/** Called only after the namespace's host and session-token guards. */
export async function handleRateCaptures(
  store: RateCaptureStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  try {
    let data: unknown;
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      if (id !== null && id !== '') {
        data = JSON.parse(await store.read(id));
      } else {
        data = await store.list();
      }
    } else if (['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
      const raw = await collectRawBody(req, RATE_CAPTURE_BODY_LIMIT_BYTES);
      const body = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
      if (req.method === 'POST') {
        data = await store.save(body);
      } else {
        const id = url.searchParams.get('id');
        if (!id) throw new Error('Choose a saved capture.');
        const input = JSON.parse(body) as { name?: string; confirm?: boolean };
        if (req.method === 'PATCH') {
          data = await store.rename(id, input.name ?? '');
        } else {
          if (input.confirm !== true) throw new Error('Confirm deletion of the saved capture.');
          await store.remove(id);
          data = { id, deleted: true };
        }
      }
    } else {
      answerAndClose(req, res, 405, { allow: 'GET, POST, PATCH, DELETE' }, '');
      return true;
    }
    const status = req.method === 'POST' ? 201 : 200;
    res
      .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(data));
  } catch (error) {
    if (isBodyTooLarge(error)) {
      answerAndClose(
        req,
        res,
        413,
        { 'content-type': 'application/json' },
        JSON.stringify({ error: 'Capture exceeds 32 MB.' }),
      );
      return true;
    }
    const message = error instanceof Error ? error.message : 'Unable to access captures.';
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
  }
  return true;
}
