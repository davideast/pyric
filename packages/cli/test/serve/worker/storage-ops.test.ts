/**
 * SharedWorker host — storage byte ops + auth lens (remote sandbox, slice 2).
 *
 * Covers the new base64 ops (`storage.putBytes` / `storage.getBytes` /
 * `storage.deleteObject`) and the `actAs` lens on ALL storage ops:
 *   - binary-faithful put → get round-trip (non-UTF8 bytes)
 *   - contentType + customMetadata round-trip
 *   - the 8 MiB raw cap, enforced on BOTH the decode end (oversized
 *     putBytes payload) and the encode end (oversized getBytes result)
 *   - idempotent delete; object-not-found on missing reads
 *   - deny-all page-configured rules: the admin lens genuinely BYPASSES
 *     them (spike risk 5), the anonymous page lens still enforces, and
 *     the `{ as: uid }` lens evaluates as that user.
 *
 * Same harness style as host.test.ts: REAL sandbox + fake ports, no
 * browser. `fake-indexeddb` backs the storage persistence; each ctx gets a
 * unique dbName so state never leaks across tests (the default
 * `pyric-storage` DB is process-global under fake-indexeddb).
 */

import 'fake-indexeddb/auto';
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox, ref as storageRef, uploadBytes } from 'pyric/storage';

import {
  handleMessage,
  type HostCtx,
  type PortLike,
} from '../../../src/serve/worker/host.js';
import type {
  InboundMessage,
  OutboundMessage,
  ResMessage,
} from '../../../src/serve/worker/protocol.js';
import {
  bytesToBase64,
  base64ToBytes,
  MAX_STORAGE_OP_BYTES,
  MAX_STORAGE_OP_B64_LENGTH,
} from '../../../src/serve/worker/protocol.js';

// ─── Harness ────────────────────────────────────────────────────────────────

// NOTE: rules are written WITHOUT the /b/{bucket}/o wrapper — pyric/storage's
// evaluator matches rules against the reference's raw fullPath (the existing
// pyric rules tests embed the wrapper INTO their object paths instead).
const DENY_ALL_RULES = `
service firebase.storage {
  match /{allPaths=**} {
    allow read, write: if false;
  }
}`;

const OWNER_ONLY_RULES = `
service firebase.storage {
  match /users/{uid}/{file} {
    allow read, write: if request.auth.uid == uid;
  }
}`;

let dbSeq = 0;
function uniqueDbName(): string {
  return `pyric-storage-worker-ops-${++dbSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Fresh worker ctx; `rules` configures the sandbox's ONE storage service
 *  (first-call-per-sandbox wins — exactly how a served page configures it). */
function makeCtx(rules?: string): HostCtx {
  const sandbox = initializeSandbox();
  // Pre-open the per-sandbox storage service with an isolated IDB name (and
  // the page's rules, when given) BEFORE any host op lazily opens it.
  getStorageSandbox(sandbox, { dbName: uniqueDbName(), ...(rules ? { rules } : {}) });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'storage-ops-test', subs: new Map() };
}

let opSeq = 0;
function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = {
      postMessage(msg: OutboundMessage) {
        if (msg.t === 'res') resolve(msg);
      },
    };
    void handleMessage(ctx, port, {
      ...payload,
      t: 'op',
      id: `sop-${++opSeq}`,
    } as InboundMessage);
  });
}

async function opOk(ctx: HostCtx, payload: Record<string, unknown>): Promise<unknown> {
  const res = await op(ctx, payload);
  if (!res.ok) throw new Error(`expected ok, got: ${res.error.code} — ${res.error.message}`);
  return res.value;
}

async function opFail(
  ctx: HostCtx,
  payload: Record<string, unknown>,
): Promise<{ code: string; message: string }> {
  const res = await op(ctx, payload);
  if (res.ok) throw new Error(`expected failure, got ok: ${JSON.stringify(res.value)}`);
  return res.error;
}

/** Non-UTF8 binary: PNG magic + 0x00/0xFF runs — the corruption regression
 *  payload from the design spike. */
function binaryFixture(): Uint8Array {
  const bytes = new Uint8Array(512);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic
  for (let i = 8; i < 256; i++) bytes[i] = 0x00;
  for (let i = 256; i < 512; i++) bytes[i] = 0xff;
  bytes[300] = 0x7f;
  return bytes;
}

const ADMIN = { actAs: { mode: 'admin' } } as const;

// ─── Byte ops ───────────────────────────────────────────────────────────────

describe('storage worker ops — putBytes / getBytes / deleteObject', () => {
  it('round-trips non-UTF8 binary byte-for-byte (base64 payloads)', async () => {
    const ctx = makeCtx();
    const bytes = binaryFixture();

    const meta = (await opOk(ctx, {
      method: 'storage.putBytes',
      path: 'blobs/probe.png',
      dataB64: bytesToBase64(bytes),
      contentType: 'image/png',
    })) as { fullPath: string; size: number; contentType: string };
    expect(meta.fullPath).toBe('blobs/probe.png');
    expect(meta.size).toBe(bytes.byteLength);
    expect(meta.contentType).toBe('image/png');

    const wire = (await opOk(ctx, {
      method: 'storage.getBytes',
      path: 'blobs/probe.png',
    })) as { dataB64: string; contentType: string; size: number };
    expect(wire.size).toBe(bytes.byteLength);
    expect(wire.contentType).toBe('image/png');
    expect(Array.from(base64ToBytes(wire.dataB64))).toEqual(Array.from(bytes));
  });

  it('round-trips contentType + customMetadata via metadata options', async () => {
    const ctx = makeCtx();
    await opOk(ctx, {
      method: 'storage.putBytes',
      path: 'docs/report.json',
      dataB64: bytesToBase64(new TextEncoder().encode('{"ok":true}')),
      metadata: {
        contentType: 'application/json',
        cacheControl: 'no-store',
        customMetadata: { owner: 'ada', run: '42' },
      },
    });
    const meta = (await opOk(ctx, {
      method: 'storage.getMetadata',
      path: 'docs/report.json',
    })) as {
      contentType: string;
      cacheControl?: string;
      customMetadata?: Record<string, string>;
    };
    expect(meta.contentType).toBe('application/json');
    expect(meta.cacheControl).toBe('no-store');
    expect(meta.customMetadata).toEqual({ owner: 'ada', run: '42' });
  });

  it('folds a GCS-style nested custom map (metadata.metadata) into customMetadata', async () => {
    const ctx = makeCtx();
    await opOk(ctx, {
      method: 'storage.putBytes',
      path: 'docs/gcs-style.txt',
      dataB64: bytesToBase64(new TextEncoder().encode('x')),
      contentType: 'text/plain',
      metadata: { metadata: { source: 'admin-arm' } },
    });
    const meta = (await opOk(ctx, {
      method: 'storage.getMetadata',
      path: 'docs/gcs-style.txt',
    })) as { customMetadata?: Record<string, string> };
    expect(meta.customMetadata).toEqual({ source: 'admin-arm' });
  });

  it('getBytes on a missing path fails storage/object-not-found', async () => {
    const ctx = makeCtx();
    const err = await opFail(ctx, { method: 'storage.getBytes', path: 'missing/nothing' });
    expect(err.code).toBe('storage/object-not-found');
  });

  it('deleteObject removes the object and is idempotent on re-delete', async () => {
    const ctx = makeCtx();
    await opOk(ctx, {
      method: 'storage.putBytes',
      path: 'tmp/scratch',
      dataB64: bytesToBase64(new Uint8Array([1, 2, 3])),
    });
    await opOk(ctx, { method: 'storage.deleteObject', path: 'tmp/scratch' });
    const err = await opFail(ctx, { method: 'storage.getBytes', path: 'tmp/scratch' });
    expect(err.code).toBe('storage/object-not-found');
    // Idempotent: deleting the now-missing path still succeeds.
    await opOk(ctx, { method: 'storage.deleteObject', path: 'tmp/scratch' });
  });
});

// ─── Size cap (both ends) ───────────────────────────────────────────────────

describe('storage worker ops — 8 MiB raw cap', () => {
  it('rejects an oversized putBytes payload BEFORE decoding it (decode end)', async () => {
    const ctx = makeCtx();
    // A base64 string longer than any within-cap payload could produce —
    // the pre-decode gate must reject without materializing bytes.
    const oversizedB64 = 'A'.repeat(MAX_STORAGE_OP_B64_LENGTH + 4);
    const err = await opFail(ctx, {
      method: 'storage.putBytes',
      path: 'big/blob',
      dataB64: oversizedB64,
    });
    expect(err.code).toBe('payload-too-large');
    expect(err.message).toContain('8 MiB');
    // Nothing was written.
    const miss = await opFail(ctx, { method: 'storage.getBytes', path: 'big/blob' });
    expect(miss.code).toBe('storage/object-not-found');
  });

  it('rejects an oversized getBytes result (encode end) — a big browser-side object cannot blow up the relay', async () => {
    const ctx = makeCtx();
    // Plant an over-cap object DIRECTLY through pyric/storage (the page's own
    // in-worker surface has no cap) …
    const storage = getStorageSandbox(ctx.sandbox);
    const big = new Uint8Array(MAX_STORAGE_OP_BYTES + 1);
    await uploadBytes(storageRef(storage, 'big/native'), big, { contentType: 'application/octet-stream' });
    // … then the relay-facing op must refuse to encode it.
    const err = await opFail(ctx, { method: 'storage.getBytes', path: 'big/native' });
    expect(err.code).toBe('payload-too-large');
    expect(err.message).toContain('8 MiB');
  });
});

// ─── Auth lens + rules (spike risk 5: page-configured rules vs admin) ──────

describe('storage worker ops — actAs lens against page-configured rules', () => {
  it('an app-session Storage operation uses the initiating port session', async () => {
    const ctx = makeCtx(OWNER_ONLY_RULES);
    const messages: OutboundMessage[] = [];
    const port: PortLike = { postMessage: (message) => messages.push(message) };
    const send = async (payload: Record<string, unknown>): Promise<ResMessage> => {
      const id = `sop-${++opSeq}`;
      await handleMessage(ctx, port, { ...payload, t: 'op', id } as InboundMessage);
      const response = messages.find((message): message is ResMessage => message.t === 'res' && message.id === id);
      if (!response) throw new Error(`missing response ${id}`);
      return response;
    };

    const signIn = await send({ method: 'auth.signInAnonymously' });
    expect(signIn.ok).toBe(true);
    if (!signIn.ok) return;
    const uid = (signIn.value as { user: { uid: string } }).user.uid;

    const put = await send({
      method: 'storage.putBytes',
      path: `users/${uid}/mine.txt`,
      dataB64: bytesToBase64(new TextEncoder().encode('mine')),
    });
    expect(put.ok).toBe(true);
  });

  it('deny-all rules: anonymous page ops are denied; the admin lens genuinely bypasses', async () => {
    const ctx = makeCtx(DENY_ALL_RULES);
    const dataB64 = bytesToBase64(binaryFixture());

    // Page (no lens): every op denied.
    const putErr = await opFail(ctx, { method: 'storage.putBytes', path: 'locked/x', dataB64 });
    expect(putErr.code).toBe('storage/unauthorized');

    // Admin lens: write, read, browse, metadata, delete — all bypass.
    await opOk(ctx, { method: 'storage.putBytes', path: 'locked/x', dataB64, ...ADMIN });
    const wire = (await opOk(ctx, { method: 'storage.getBytes', path: 'locked/x', ...ADMIN })) as {
      dataB64: string;
    };
    expect(wire.dataB64).toBe(dataB64);
    const listing = (await opOk(ctx, { method: 'storage.listAll', path: 'locked', ...ADMIN })) as {
      items: Array<{ fullPath: string }>;
    };
    expect(listing.items.map((i) => i.fullPath)).toEqual(['locked/x']);
    await opOk(ctx, { method: 'storage.getMetadata', path: 'locked/x', ...ADMIN });

    // Page reads stay denied even though the object exists (rules first).
    const readErr = await opFail(ctx, { method: 'storage.getBytes', path: 'locked/x' });
    expect(readErr.code).toBe('storage/unauthorized');
    const blobErr = await opFail(ctx, { method: 'storage.getBlob', path: 'locked/x' });
    expect(blobErr.code).toBe('storage/unauthorized');
    const listErr = await opFail(ctx, { method: 'storage.listAll', path: 'locked' });
    expect(listErr.code).toBe('storage/unauthorized');

    await opOk(ctx, { method: 'storage.deleteObject', path: 'locked/x', ...ADMIN });
    const gone = await opFail(ctx, { method: 'storage.getBytes', path: 'locked/x', ...ADMIN });
    expect(gone.code).toBe('storage/object-not-found');
  });

  it('the { as: uid } lens evaluates rules AS that user (owner-only ruleset)', async () => {
    const ctx = makeCtx(OWNER_ONLY_RULES);
    const dataB64 = bytesToBase64(new TextEncoder().encode('mine'));
    const asAda = { actAs: { mode: 'as', uid: 'ada' } } as const;
    const asBob = { actAs: { mode: 'as', uid: 'bob' } } as const;

    await opOk(ctx, { method: 'storage.putBytes', path: 'users/ada/notes.txt', dataB64, ...asAda });
    const wire = (await opOk(ctx, {
      method: 'storage.getBytes',
      path: 'users/ada/notes.txt',
      ...asAda,
    })) as { dataB64: string };
    expect(wire.dataB64).toBe(dataB64);

    // Bob is not ada: denied on both write and read.
    const writeErr = await opFail(ctx, {
      method: 'storage.putBytes', path: 'users/ada/notes.txt', dataB64, ...asBob,
    });
    expect(writeErr.code).toBe('storage/unauthorized');
    const readErr = await opFail(ctx, {
      method: 'storage.getBytes', path: 'users/ada/notes.txt', ...asBob,
    });
    expect(readErr.code).toBe('storage/unauthorized');

    // Admin still bypasses the owner scoping entirely.
    await opOk(ctx, { method: 'storage.getMetadata', path: 'users/ada/notes.txt', ...ADMIN });
  });
});
