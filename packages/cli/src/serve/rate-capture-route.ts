import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RateCaptureStore } from './rate-capture-store.js';

/** Called only after the namespace's host and session-token guards. */
export async function handleRateCaptures(store: RateCaptureStore, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  try {
    let data: unknown;
    if (req.method === 'GET') {
      const id = url.searchParams.get('id');
      data = id ? JSON.parse(await store.read(id)) : await store.list();
    } else if (['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 32 * 1024 * 1024) throw new Error('Capture exceeds 32 MB.');
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'POST') data = await store.save(body);
      else {
        const id = url.searchParams.get('id');
        if (!id) throw new Error('Choose a saved capture.');
        const input = JSON.parse(body);
        if (req.method === 'PATCH') data = await store.rename(id, input.name);
        else {
          if (input.confirm !== true) throw new Error('Confirm deletion of the saved capture.');
          await store.remove(id); data = { id, deleted: true };
        }
      }
    } else {
      res.writeHead(405, { allow: 'GET, POST, PATCH, DELETE' }).end(); return true;
    }
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(data));
  } catch (error) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to access captures.' }));
  }
  return true;
}
