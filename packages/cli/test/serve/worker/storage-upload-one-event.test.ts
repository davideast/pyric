/**
 * One upload over the byte route records one `create` operation event
 * (#1313 follow-up). Beginning the upload checks the rules early and
 * finishing it checks them again as the object lands; Studio Traffic and
 * `pyric verify` read one decision per upload, so only a denial at the
 * early check is recorded there.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';

const RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /open/{file} { allow read, write: if true; }
  }
}`;

let seq = 0;

function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-storage-upload-one-event-${++seq}-${Math.random()}`, rules: RULES });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'storage-upload-one-event', subs: new Map() };
}

function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, { ...payload, t: 'op', id: `one-${++seq}` } as InboundMessage);
  });
}

/** Begin, stage and finish one chunked upload; the code of the step that failed, or 'ok'. */
async function chunkedUpload(ctx: HostCtx, path: string): Promise<string> {
  const bytes = new TextEncoder().encode('hi');
  const begun = await op(ctx, { method: 'storage.beginUpload', path, size: bytes.byteLength, contentType: 'text/plain' });
  if (!begun.ok) return begun.error.code;
  const { uploadId } = begun.value as { uploadId: string };
  const staged = await op(ctx, { method: 'storage.putPart', uploadId, partIndex: 0, dataB64: bytesToBase64(bytes) });
  if (!staged.ok) return staged.error.code;
  const finished = await op(ctx, { method: 'storage.finishUpload', uploadId });
  return finished.ok ? 'ok' : finished.error.code;
}

/** The Storage `create` decisions on the sandbox stream, as `<path> <result>`. */
function createDecisions(ctx: HostCtx): string[] {
  return ctx.sandbox.history().flatMap((event) => {
    const isCreate = event.kind === 'operation' && event.service === 'storage' && event.method === 'create';
    return isCreate ? [`${event.path} ${event.result}`] : [];
  });
}

describe('a chunked Storage upload records one create decision', () => {
  it('records one allow for an upload the rules allow', async () => {
    const ctx = makeCtx();
    expect(await chunkedUpload(ctx, 'open/a.txt')).toBe('ok');
    expect(createDecisions(ctx)).toEqual(['open/a.txt allow']);
  });

  it('records one deny for an upload the rules deny', async () => {
    const ctx = makeCtx();
    expect(await chunkedUpload(ctx, 'closed/a.txt')).toBe('storage/unauthorized');
    expect(createDecisions(ctx)).toEqual(['closed/a.txt deny']);
  });
});
