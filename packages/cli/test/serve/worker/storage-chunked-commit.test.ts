/**
 * A chunked upload commits through the same engine path as a single-frame
 * `storage.putBytes`: the same metadata fields, the sandbox clock, rules
 * evaluated when the object is created, and one mutation event.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox, type SandboxEvent } from 'pyric/sandbox';
import { getClock } from 'pyric/sandbox/internal';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';
import { replaceStorageRules } from 'pyric/storage/internal';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';
import { OPEN_STORAGE_RULES } from './permissive-services.js';

let seq = 0;
function makeCtx(rules = OPEN_STORAGE_RULES): { ctx: HostCtx; events: SandboxEvent[] } {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-chunked-commit-${++seq}-${Math.random().toString(36).slice(2, 8)}`, rules });
  const events: SandboxEvent[] = [];
  sandbox.onEvent((event) => events.push(event));
  return { ctx: { db: getFirestore(sandbox), sandbox, instanceId: 'chunked-commit-test', subs: new Map() }, events };
}

function op(ctx: HostCtx, payload: Record<string, unknown>): Promise<ResMessage> {
  return new Promise((resolve) => {
    const port: PortLike = { postMessage(msg: OutboundMessage) { if (msg.t === 'res') resolve(msg); } };
    void handleMessage(ctx, port, { ...payload, t: 'op', id: `commit-op-${++seq}` } as InboundMessage);
  });
}

async function ok<T>(ctx: HostCtx, payload: Record<string, unknown>): Promise<T> {
  const res = await op(ctx, payload);
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as T;
}

type Metadata = Record<string, unknown> & { generation: string; timeCreated: string; updated: string };

const SETTABLE = {
  cacheControl: 'public, max-age=60',
  contentDisposition: 'inline',
  contentEncoding: 'identity',
  contentLanguage: 'en',
  customMetadata: { owner: 'alice' },
};

async function single(ctx: HostCtx, path: string, bytes: Uint8Array): Promise<Metadata> {
  return ok<Metadata>(ctx, { method: 'storage.putBytes', path, dataB64: bytesToBase64(bytes), contentType: 'audio/wav', metadata: SETTABLE });
}

async function chunked(ctx: HostCtx, path: string, bytes: Uint8Array): Promise<ResMessage> {
  const { uploadId } = await ok<{ uploadId: string }>(ctx, {
    method: 'storage.beginUpload', path, size: bytes.byteLength, contentType: 'audio/wav', metadata: SETTABLE,
  });
  const half = Math.floor(bytes.byteLength / 2);
  await ok(ctx, { method: 'storage.putPart', uploadId, partIndex: 0, dataB64: bytesToBase64(bytes.subarray(0, half)) });
  await ok(ctx, { method: 'storage.putPart', uploadId, partIndex: 1, dataB64: bytesToBase64(bytes.subarray(half)) });
  return op(ctx, { method: 'storage.finishUpload', uploadId });
}

const BYTES = new Uint8Array(2048).map((_, index) => index % 251);
const COMPARED = ['size', 'contentType', 'cacheControl', 'contentDisposition', 'contentEncoding', 'contentLanguage', 'customMetadata', 'metageneration'];

describe('a chunked upload commits through the engine upload path', () => {
  it('stores the same metadata fields as a single-frame upload', async () => {
    const { ctx } = makeCtx();
    const expected = await single(ctx, 'single/a.wav', BYTES);
    const res = await chunked(ctx, 'chunked/a.wav', BYTES);
    if (!res.ok) throw new Error(res.error.message);
    const actual = res.value as Metadata;
    for (const key of COMPARED) expect({ key, value: actual[key] }).toEqual({ key, value: expected[key] });
  });

  it('stamps times and generation from the sandbox clock', async () => {
    const { ctx } = makeCtx();
    getClock(ctx.sandbox).set(Date.UTC(2030, 0, 1));
    const expected = await single(ctx, 'single/b.wav', BYTES);
    const res = await chunked(ctx, 'chunked/b.wav', BYTES);
    if (!res.ok) throw new Error(res.error.message);
    const actual = res.value as Metadata;
    expect(actual.timeCreated).toBe('2030-01-01T00:00:00.000Z');
    expect(actual.updated).toBe(expected.updated);
    expect(actual.generation).toBe(expected.generation);
  });

  it('evaluates rules when the object is created, not only when the upload begins', async () => {
    const { ctx } = makeCtx();
    const { uploadId } = await ok<{ uploadId: string }>(ctx, {
      method: 'storage.beginUpload', path: 'gated/c.wav', size: BYTES.byteLength, contentType: 'audio/wav',
    });
    await ok(ctx, { method: 'storage.putPart', uploadId, partIndex: 0, dataB64: bytesToBase64(BYTES) });
    await replaceStorageRules(ctx.sandbox, `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /gated/{file} { allow read: if true; allow write: if false; }
  }
}`);
    const res = await op(ctx, { method: 'storage.finishUpload', uploadId });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('storage/unauthorized');
    const read = await op(ctx, { method: 'storage.getBytes', path: 'gated/c.wav' });
    expect(read.ok).toBe(false);
  });

  it('emits one object_put event shaped like a single-frame upload', async () => {
    const { ctx, events } = makeCtx();
    await single(ctx, 'single/d.wav', BYTES);
    const res = await chunked(ctx, 'chunked/d.wav', BYTES);
    if (!res.ok) throw new Error(res.error.message);
    const puts = (path: string) => events.filter((event) => {
      const mutation = event as { kind?: string; op?: string; path?: string };
      return mutation.kind === 'service_mutation' && mutation.op === 'object_put' && mutation.path === path;
    }) as Array<{ detail?: Record<string, unknown> }>;
    expect(puts('chunked/d.wav').length).toBe(1);
    expect(Object.keys(puts('chunked/d.wav')[0]!.detail ?? {}).sort()).toEqual(Object.keys(puts('single/d.wav')[0]!.detail ?? {}).sort());
  });
});
