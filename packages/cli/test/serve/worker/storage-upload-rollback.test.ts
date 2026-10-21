/**
 * Rolling back a canceled upload on the host (#1157).
 *
 * pyric stores a resumable upload's object before the task finishes, so a
 * cancel that races the commit has to remove it. Production never stores a
 * canceled upload, so its rules never see a delete. The host therefore rolls
 * back the upload's own write without evaluating rules, and only that write:
 * a commit that asks for it gets a token bound to the client that sent it and
 * to the object generation it stored. These tests drive `handleMessage` with
 * a real sandbox and fake ports, one port per client.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, setSystemTime } from 'bun:test';
import { createMemoryBackend, initializeSandbox } from 'pyric/sandbox';
import { getAuth } from 'pyric/auth';
import { getFirestore } from 'pyric/firestore';
import { getStorageSandbox } from 'pyric/storage';

import { handleMessage, type HostCtx, type PortLike } from '../../../src/serve/worker/host.js';
import { ROLLBACK_GRANT_TTL_MS } from '../../../src/serve/worker/host/upload-rollback.js';
import type { InboundMessage, OutboundMessage, ResMessage } from '../../../src/serve/worker/protocol.js';
import { bytesToBase64 } from '../../../src/serve/worker/protocol.js';

/** The issue's rules: any signed-in user may create an upload, and nobody may delete one. */
const CREATE_ONLY_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow read: if true;
      allow create: if request.auth != null;
      allow delete: if false;
    }
  }
}`;

const ADMIN = { actAs: { mode: 'admin' } } as const;
const SIGNED_IN = { actAs: { mode: 'as', uid: 'ada' } } as const;

let dbSeq = 0;
function makeCtx(): HostCtx {
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-upload-rollback-${++dbSeq}-${Math.random().toString(36).slice(2)}`, rules: CREATE_ONLY_RULES });
  return { db: getFirestore(sandbox), sandbox, instanceId: 'upload-rollback-test', subs: new Map() };
}

type Client = (payload: Record<string, unknown>) => Promise<ResMessage>;

let opSeq = 0;
/**
 * One client: every call goes over the same port, as one connection's calls
 * do. With `clientSessionId`, it is a remote client session on that port.
 */
function clientOf(ctx: HostCtx, port: PortLike = replyingPort(), clientSessionId?: string): Client {
  return (payload) => new Promise((resolve) => {
    const id = `rollback-${++opSeq}`;
    waitingReplies.set(id, resolve);
    const session = clientSessionId === undefined ? {} : { clientSessionId };
    void handleMessage(ctx, port, { ...payload, ...session, t: 'op', id } as InboundMessage);
  });
}

const waitingReplies = new Map<string, (reply: ResMessage) => void>();

function replyingPort(): PortLike {
  return {
    postMessage(message: OutboundMessage) {
      if (message.t === 'res') waitingReplies.get(message.id)?.(message);
    },
  };
}

async function valueOf(reply: Promise<ResMessage>): Promise<Record<string, unknown>> {
  const res = await reply;
  if (!res.ok) throw new Error(`expected ok, got ${res.error.code}: ${res.error.message}`);
  return res.value as Record<string, unknown>;
}

async function errorOf(reply: Promise<ResMessage>): Promise<{ code: string; message: string }> {
  const res = await reply;
  if (res.ok) throw new Error(`expected a failure, got ${JSON.stringify(res.value)}`);
  return res.error;
}

const text = (value: string) => bytesToBase64(new TextEncoder().encode(value));

function put(client: Client, path: string, value: string, extra: Record<string, unknown> = {}) {
  return valueOf(client({ method: 'storage.putBytes', path, dataB64: text(value), ...SIGNED_IN, ...extra }));
}

async function stored(client: Client, path: string): Promise<string | undefined> {
  const res = await client({ method: 'storage.getBytes', path, ...ADMIN });
  if (!res.ok) return undefined;
  const { dataB64 } = res.value as { dataB64: string };
  return new TextDecoder().decode(Uint8Array.from(atob(dataB64), (char) => char.charCodeAt(0)));
}

afterEach(() => setSystemTime());

describe('a commit asks the host for its rollback token', () => {
  it('putBytes with rollback returns a token beside the metadata; one without it returns none', async () => {
    const client = clientOf(makeCtx());
    const asked = await put(client, 'uploads/a.png', 'one', { rollback: true });
    expect(typeof asked.rollbackToken).toBe('string');
    expect(asked.fullPath).toBe('uploads/a.png');
    const plain = await put(client, 'uploads/b.png', 'two');
    expect(plain.rollbackToken).toBeUndefined();
  });

  it('rolls back the upload although the rules deny its delete, and the task can say it deleted it', async () => {
    const client = clientOf(makeCtx());
    const { rollbackToken } = await put(client, 'uploads/a.png', 'canceled', { rollback: true });
    expect(await errorOf(client({ method: 'storage.deleteObject', path: 'uploads/a.png', ...SIGNED_IN })))
      .toMatchObject({ code: 'storage/unauthorized' });
    expect(await valueOf(client({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN }))).toEqual({ deleted: true });
    expect(await stored(client, 'uploads/a.png')).toBeUndefined();
  });

  it('issues the token on a chunked finishUpload too, the commit the byte route ends with', async () => {
    const client = clientOf(makeCtx());
    const { uploadId } = await valueOf(client({ method: 'storage.beginUpload', path: 'uploads/parts.bin', size: 5, ...SIGNED_IN }));
    await valueOf(client({ method: 'storage.putPart', uploadId, partIndex: 0, dataB64: text('parts'), ...SIGNED_IN }));
    const finished = await valueOf(client({ method: 'storage.finishUpload', uploadId, rollback: true, ...SIGNED_IN }));
    expect(finished.fullPath).toBe('uploads/parts.bin');
    expect(await valueOf(client({ method: 'storage.rollbackUpload', rollbackToken: finished.rollbackToken, ...SIGNED_IN })))
      .toEqual({ deleted: true });
    expect(await stored(client, 'uploads/parts.bin')).toBeUndefined();
  });
});

describe('the rollback deletes only that client\'s own commit', () => {
  it('deletes nothing once another write replaced the generation it stored', async () => {
    const client = clientOf(makeCtx());
    const { rollbackToken } = await put(client, 'uploads/a.png', 'canceled', { rollback: true });
    await put(client, 'uploads/a.png', 'written after', ADMIN);
    expect(await valueOf(client({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN }))).toEqual({ deleted: false });
    expect(await stored(client, 'uploads/a.png')).toBe('written after');
  });

  it('refuses a token sent by another client, and the client it was issued to can still use it', async () => {
    const ctx = makeCtx();
    const owner = clientOf(ctx);
    const other = clientOf(ctx);
    const { rollbackToken } = await put(owner, 'uploads/a.png', 'canceled', { rollback: true });
    expect(await errorOf(other({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN })))
      .toMatchObject({ code: 'storage/unauthorized' });
    expect(await stored(owner, 'uploads/a.png')).toBe('canceled');
    expect(await valueOf(owner({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN }))).toEqual({ deleted: true });
  });

  it('tells remote client sessions on one physical port apart', async () => {
    const ctx = makeCtx();
    const physical = replyingPort();
    const first = clientOf(ctx, physical, 'node-process-1');
    const second = clientOf(ctx, physical, 'node-process-2');
    const { rollbackToken } = await put(first, 'uploads/a.png', 'canceled', { rollback: true });
    expect(await errorOf(second({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN })))
      .toMatchObject({ code: 'storage/unauthorized' });
    expect(await valueOf(first({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN }))).toEqual({ deleted: true });
  });

  it('refuses a token used once already', async () => {
    const client = clientOf(makeCtx());
    const { rollbackToken } = await put(client, 'uploads/a.png', 'canceled', { rollback: true });
    expect(await valueOf(client({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN }))).toEqual({ deleted: true });
    await put(client, 'uploads/a.png', 'written again', ADMIN);
    expect(await errorOf(client({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN })))
      .toMatchObject({ code: 'storage/unauthorized' });
    expect(await stored(client, 'uploads/a.png')).toBe('written again');
  });

  it('refuses a token past its lifetime and deletes nothing', async () => {
    const client = clientOf(makeCtx());
    const issuedAt = Date.now();
    setSystemTime(issuedAt);
    const { rollbackToken } = await put(client, 'uploads/a.png', 'canceled', { rollback: true });
    setSystemTime(issuedAt + ROLLBACK_GRANT_TTL_MS + 1);
    expect(await errorOf(client({ method: 'storage.rollbackUpload', rollbackToken, ...SIGNED_IN })))
      .toMatchObject({ code: 'storage/unauthorized' });
    expect(await stored(client, 'uploads/a.png')).toBe('canceled');
  });

  it('refuses a token it never issued', async () => {
    const client = clientOf(makeCtx());
    await put(client, 'uploads/a.png', 'kept');
    expect(await errorOf(client({ method: 'storage.rollbackUpload', rollbackToken: 'not-a-token', ...SIGNED_IN })))
      .toMatchObject({ code: 'storage/unauthorized' });
    expect(await stored(client, 'uploads/a.png')).toBe('kept');
  });
});

// ─── The worker client's resumable task ─────────────────────────────────────

/** The issue's rules for a client with no user: the create is allowed, every delete denied. */
const OPEN_CREATE_ONLY_RULES = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      allow read, create: if true;
      allow delete: if false;
    }
  }
}`;

/** A reply as a host that predates the rollback token sends it. */
function withoutToken(message: OutboundMessage): OutboundMessage {
  const isValueReply = message.t === 'res' && message.ok && message.value !== null && typeof message.value === 'object';
  if (!isValueReply) return message;
  const { rollbackToken: _dropped, ...value } = message.value as Record<string, unknown>;
  return { ...message, value };
}

/**
 * Attach a worker client to a host with create-only rules. With
 * `hostSendsNoToken`, the replies lose their rollback token.
 */
async function connectWorkerClient(options: { hostSendsNoToken?: boolean } = {}) {
  const { portPair } = await import('./integration-support.js');
  const client = await import('../../../src/serve/worker/client.js');
  const storageClient = await import('../../../src/serve/worker/client/storage.js');
  const sandbox = initializeSandbox();
  getStorageSandbox(sandbox, { dbName: `pyric-upload-rollback-client-${++dbSeq}`, rules: OPEN_CREATE_ONLY_RULES });
  getAuth(sandbox);
  const ctx: HostCtx = {
    db: getFirestore(sandbox), sandbox, instanceId: 'upload-rollback-client', subs: new Map(),
    sessionMode: 'LOCAL', sessionBackend: createMemoryBackend(),
  };
  const { a: clientPort, b: hostPort } = portPair();
  const toClient: PortLike = {
    postMessage: (message: OutboundMessage) => hostPort.postMessage(options.hostSendsNoToken ? withoutToken(message) : message),
  };
  hostPort.onmessage = (event) => {
    void handleMessage(ctx, toClient, event.data as InboundMessage);
  };
  (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
    port = clientPort;
    constructor(_url: unknown, _opts: unknown) {}
  };
  const storage = storageClient.getStorage(client.getFirestore(`worker://upload-rollback-${dbSeq}`));
  const admin = clientOf(ctx);
  return { storage, storageClient, read: (path: string) => stored(admin, path) };
}

async function untilStored(read: () => Promise<string | undefined>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (await read() === undefined) {
    if (Date.now() > deadline) throw new Error('the paused commit was never stored');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('a canceled worker upload under rules that allow its create and deny its delete', () => {
  it('rejects storage/canceled and leaves no object, for a cancel right after the call', async () => {
    const { storage, storageClient, read } = await connectWorkerClient();
    const task = storageClient.uploadBytesResumable(storageClient.ref(storage, 'uploads/a.png'), new TextEncoder().encode('canceled'));
    expect(task.cancel()).toBe(true);
    await expect(Promise.resolve(task)).rejects.toMatchObject({ code: 'storage/canceled' });
    expect(await read('uploads/a.png')).toBeUndefined();
  });

  it('rejects storage/canceled and leaves no object, for a commit held while paused', async () => {
    const { storage, storageClient, read } = await connectWorkerClient();
    const target = storageClient.ref(storage, 'uploads/held.png');
    const task = storageClient.uploadBytesResumable(target, new TextEncoder().encode('held'));
    expect(task.pause()).toBe(true);
    await untilStored(() => storageClient.getBytes(target).then(() => 'stored', () => undefined));
    expect(task.cancel()).toBe(true);
    await expect(Promise.resolve(task)).rejects.toMatchObject({ code: 'storage/canceled' });
    expect(await read('uploads/held.png')).toBeUndefined();
  });

  it('keeps the token out of a completed upload\'s metadata', async () => {
    const { storage, storageClient } = await connectWorkerClient();
    const done = await storageClient.uploadBytesResumable(storageClient.ref(storage, 'uploads/kept.png'), new Uint8Array([1]));
    expect(done.metadata.fullPath).toBe('uploads/kept.png');
    expect('rollbackToken' in done.metadata).toBe(false);
  });

  it('against a host that sends no token, falls back to the delete the rules decide', async () => {
    const { storage, storageClient, read } = await connectWorkerClient({ hostSendsNoToken: true });
    const task = storageClient.uploadBytesResumable(storageClient.ref(storage, 'uploads/old-host.png'), new TextEncoder().encode('old host'));
    expect(task.cancel()).toBe(true);
    await expect(Promise.resolve(task)).rejects.toMatchObject({ code: 'storage/unauthorized' });
    expect(await read('uploads/old-host.png')).toBe('old host');
  });
});
