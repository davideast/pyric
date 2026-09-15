import { createRateCaptureStore } from './rate-capture-store.js';

/** Shared host operations for the chip's store and both sandbox tool transports. */
export async function runCaptureMethod(method: 'saveCapture' | 'listCaptures' | 'openCapture' | 'renameCapture' | 'deleteCapture', args: Record<string, unknown>, projectDir: string) {
  const store = createRateCaptureStore(projectDir);
  if (method === 'saveCapture') return { ok: true, summary: 'Saved project capture.', data: await store.save(String(args.capture)) };
  if (method === 'renameCapture') return { ok: true, summary: 'Renamed capture.', data: await store.rename(String(args.id), args.name as string) };
  if (method === 'deleteCapture') {
    if (args.confirm !== true) return { ok: false, summary: 'Confirm deletion of the saved capture.' };
    await store.remove(String(args.id)); return { ok: true, summary: 'Deleted capture.', data: { id: args.id, deleted: true } };
  }
  if (method === 'listCaptures') {
    const captures = await store.list();
    return { ok: true, summary: `${captures.length} saved captures.`, data: { captures } };
  }
  const id = typeof args.id === 'string' ? args.id : (await store.list())[0]?.id;
  if (!id) return { ok: false, summary: 'No saved captures.' };
  return { ok: true, summary: 'Opened capture for read-only inspection.', data: JSON.parse(await store.read(id)) };
}
