/**
 * The SharedWorker and Node host evaluate Storage rules under the name the
 * caller knows the bucket by, not the store key `pyric-default` (ST-H2-4).
 * The page's `storageBucket`, a caller's `defaultBucket`, and a bucket an op
 * names each reach the match path, `request.resource.bucket` and
 * `resource.bucket`, as production binds them.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';

const BUCKET = 'demo-app.appspot.com';

const LITERAL_RULES = `rules_version = '2';
service firebase.storage {
  match /b/${BUCKET}/o {
    match /{file=**} {
      allow read, write: if true;
    }
  }
}`;

const BOUND_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /wildcard/{file} {
      allow read, write: if bucket == '${BUCKET}';
    }
    match /request/{file} {
      allow write: if request.resource.bucket == '${BUCKET}';
    }
    match /resource/{file} {
      allow write: if true;
      allow read: if resource.bucket == '${BUCKET}';
    }
  }
}`;

let seq = 0;

function makeCtx(rules: string, storageBucket: string | undefined = BUCKET): HostCtx {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-storage-bucket-name-${++seq}-${Math.random()}`, rules });
  return {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'storage-bucket-name-test',
    subs: new Map(),
    ...(storageBucket === undefined ? {} : { appOptions: { projectId: 'demo-app', storageBucket } }),
  };
}

function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, { ...payload, t: 'op', id: `bn-${++seq}` } as InboundMessage);
  });
}

async function opOk(ctx: HostCtx, payload: Record<string, unknown>): Promise<unknown> {
  const res = await op(ctx, payload);
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.code} ${res.error.message}`);
  return res.value;
}

function put(path: string, extra: Record<string, unknown> = {}) {
  return { method: 'storage.putBytes', path, dataB64: bytesToBase64(new TextEncoder().encode('hi')), ...extra };
}

describe('worker Storage rules see the bucket by its name', () => {
  it('matches a literal match /b/<storageBucket>/o', async () => {
    await opOk(makeCtx(LITERAL_RULES), put('a.txt'));
  });

  it('binds {bucket} and request.resource.bucket to the page app storageBucket', async () => {
    const ctx = makeCtx(BOUND_RULES);
    await opOk(ctx, put('wildcard/a.txt'));
    await opOk(ctx, put('request/a.txt'));
  });

  it('binds resource.bucket to the page app storageBucket', async () => {
    const ctx = makeCtx(BOUND_RULES);
    await opOk(ctx, put('resource/a.txt'));
    await opOk(ctx, { method: 'storage.getMetadata', path: 'resource/a.txt' });
  });

  it('uses the default bucket name a caller sends when the page named none', async () => {
    const ctx = makeCtx(BOUND_RULES, undefined);
    await opOk(ctx, put('wildcard/b.txt', { defaultBucket: BUCKET }));
  });

  it('uses the bucket an op names', async () => {
    const ctx = makeCtx(BOUND_RULES, undefined);
    await opOk(ctx, put('wildcard/c.txt', { bucket: BUCKET, defaultBucket: BUCKET }));
  });

  it('checks a chunked upload under the bucket name', async () => {
    const ctx = makeCtx(BOUND_RULES);
    await opOk(ctx, { method: 'storage.beginUpload', path: 'request/big.bin', size: 2, contentType: 'application/octet-stream' });
  });

  it('reports the metadata bucket as before', async () => {
    const meta = (await opOk(makeCtx(BOUND_RULES), put('wildcard/d.txt'))) as { bucket: string };
    expect(meta.bucket).toBe(BUCKET);
  });
});
