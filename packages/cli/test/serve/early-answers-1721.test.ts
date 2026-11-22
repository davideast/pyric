import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageByteRoute, type UploadSessionView } from '../../src/serve/hosted/storage-byte-route.js';
import { UploadOffsetError, type UploadProgress } from '../../src/serve/hosted/persistence/storage.js';
import { createPyricNamespace } from '../../src/serve/namespace.js';
import { handleRateCaptures, RATE_CAPTURE_BODY_LIMIT_BYTES } from '../../src/serve/rate-capture-route.js';
import { createRateCaptureStore } from '../../src/serve/rate-capture-store.js';
import { projectCaptures } from '../../src/serve/runtime/project-captures.js';
import { handleState, STATE_BODY_LIMIT_BYTES } from '../../src/serve/state-capture-route.js';
import { createStateStore } from '../../src/serve/state-store.js';
import { createWriterLock } from '../../src/serve/writer-lock.js';
import { expectClosedEarlyAnswer } from './early-answer.js';

const servers: Server[] = [];
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function listenLoopback(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function chunkedBytes(totalBytes: number, chunkBytes = 64 * 1024): ReadableStream<Uint8Array> {
  let remaining = totalBytes;
  const block = new Uint8Array(chunkBytes).fill(0x78);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const take = Math.min(remaining, block.byteLength);
      remaining -= take;
      controller.enqueue(take === block.byteLength ? block : block.subarray(0, take));
    },
  });
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop();
    if (server === undefined) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('hosted storage byte route early answers (#1721)', () => {
  it('closes the connection on every early upload and session refusal before or during body reads', async () => {
    const progressByUpload = new Map<string, UploadProgress>([
      ['u-active', { received: 4, size: 16 }],
      ['u-zero', { received: 0, size: 16 }],
      ['u-race', { received: 0, size: 16 }],
    ]);
    const sessions = new Map<string, UploadSessionView>([
      ['s-new', { token: 'sess-tok', origin: 'http://app.local' }],
      ['s-fail-open', { token: 'sess-tok', origin: 'http://app.local' }],
      ['s-lost', { token: 'sess-tok', origin: 'http://app.local', uploadId: 'u-missing' }],
      ['s-open', { token: 'sess-tok', origin: 'http://app.local', uploadId: 'u-active' }],
    ]);

    const route = createStorageByteRoute({
      storage: {
        objectFile: async () => undefined,
        uploadProgress: async (uploadId) => progressByUpload.get(uploadId),
        appendUpload: async (uploadId, offset, bytes) => {
          if (uploadId === 'u-race') {
            throw new UploadOffsetError(8);
          }
          const current = progressByUpload.get(uploadId);
          const nextReceived = (current?.received ?? offset) + bytes.byteLength;
          return { received: nextReceived, size: current?.size ?? nextReceived };
        },
      },
      sessionToken: 'host-session',
      uploadToken: (uploadId) => (uploadId.startsWith('u-') ? 'up-tok' : undefined),
      sessions: {
        get: (sessionId) => sessions.get(sessionId),
        open: async (sessionId, size) => {
          if (sessionId === 's-fail-open') {
            throw new Error('Quota refused upload session');
          }
          progressByUpload.set('u-session', { received: 0, size });
          return 'u-session';
        },
        finish: async () => ({ ok: true }),
      },
    });

    const base = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void route(req, res, url).then((handled) => {
        if (!handled) res.writeHead(200).end('next-ok');
      });
    });
    const healthUrl = `${base}/health`;
    const body = new Uint8Array(128 * 1024).fill(0x61);
    const uploadBase = `${base}/__pyric/storage/v0/b/demo-bucket/o`;

    const cases: Array<{ label: string; url: string; init: RequestInit; status: number }> = [
      {
        label: 'malformed byte-route path',
        url: `${base}/__pyric/storage/v0/b/`,
        init: { method: 'PUT', body },
        status: 404,
      },
      {
        label: 'object route non-GET method',
        url: `${base}/__pyric/storage/v0/b/demo-bucket/o/file.bin`,
        init: { method: 'PUT', body },
        status: 405,
      },
      {
        label: 'upload non-PUT method',
        url: `${uploadBase}?name=a.bin&upload_id=u-active&upload_token=up-tok`,
        init: { method: 'POST', body },
        status: 405,
      },
      {
        label: 'upload wrong token',
        url: `${uploadBase}?name=a.bin&upload_id=u-active&upload_token=wrong`,
        init: { method: 'PUT', body },
        status: 403,
      },
      {
        label: 'unknown upload id',
        url: `${uploadBase}?name=a.bin&upload_id=u-missing&upload_token=up-tok`,
        init: { method: 'PUT', body },
        status: 404,
      },
      {
        label: 'unreadable Content-Range',
        url: `${uploadBase}?name=a.bin&upload_id=u-active&upload_token=up-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes invalid' }, body },
        status: 400,
      },
      {
        label: 'backwards Content-Range',
        url: `${uploadBase}?name=a.bin&upload_id=u-active&upload_token=up-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes 8-4/16' }, body },
        status: 400,
      },
      {
        label: 'mismatched Content-Range total',
        url: `${uploadBase}?name=a.bin&upload_id=u-active&upload_token=up-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes 4-7/99' }, body },
        status: 400,
      },
      {
        label: 'Content-Range end past upload size',
        url: `${uploadBase}?name=a.bin&upload_id=u-active&upload_token=up-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes 4-16/16' }, body },
        status: 400,
      },
      {
        label: 'misplaced upload start offset',
        url: `${uploadBase}?name=a.bin&upload_id=u-active&upload_token=up-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes 0-7/16' }, body },
        status: 409,
      },
      {
        label: 'Content-Length disagrees with Content-Range',
        url: `${uploadBase}?name=a.bin&upload_id=u-zero&upload_token=up-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes 0-7/16' }, body },
        status: 400,
      },
      {
        label: 'session disallowed preflight origin',
        url: `${uploadBase}?upload_id=s-new&upload_token=sess-tok`,
        init: { method: 'OPTIONS', headers: { origin: 'http://evil.local' } },
        status: 403,
      },
      {
        label: 'session non-PUT method',
        url: `${uploadBase}?upload_id=s-new&upload_token=sess-tok`,
        init: { method: 'POST', body },
        status: 405,
      },
      {
        label: 'session bad token',
        url: `${uploadBase}?upload_id=s-new&upload_token=wrong`,
        init: { method: 'PUT', body },
        status: 403,
      },
      {
        label: 'session unreadable Content-Range',
        url: `${uploadBase}?upload_id=s-new&upload_token=sess-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes nope' }, body },
        status: 400,
      },
      {
        label: 'session unknown total on first slice',
        url: `${uploadBase}?upload_id=s-new&upload_token=sess-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes 0-3/*' }, body },
        status: 400,
      },
      {
        label: 'session open failure',
        url: `${uploadBase}?upload_id=s-fail-open&upload_token=sess-tok`,
        init: { method: 'PUT', body },
        status: 400,
      },
      {
        label: 'session lost upload progress',
        url: `${uploadBase}?upload_id=s-lost&upload_token=sess-tok`,
        init: { method: 'PUT', body },
        status: 404,
      },
      {
        label: 'session contradicting total',
        url: `${uploadBase}?upload_id=s-open&upload_token=sess-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes 4-7/32' }, body },
        status: 400,
      },
      {
        label: 'session wildcard slice past session size',
        url: `${uploadBase}?upload_id=s-open&upload_token=sess-tok`,
        init: { method: 'PUT', headers: { 'content-range': 'bytes 4-20/*' }, body },
        status: 400,
      },
    ];

    for (const entry of cases) {
      const response = await fetch(entry.url, entry.init);
      await expectClosedEarlyAnswer(response, entry.status, healthUrl);
    }

    // Chunked body (no Content-Length) exceeding Content-Range and UploadOffsetError mid-stream
    const chunkedOverflow = await fetch(`${uploadBase}?name=a.bin&upload_id=u-zero&upload_token=up-tok`, {
      method: 'PUT',
      headers: { 'content-range': 'bytes 0-7/16' },
      body: chunkedBytes(64 * 1024, 16 * 1024),
    });
    await expectClosedEarlyAnswer(chunkedOverflow, 400, healthUrl);

    const chunkedRace = await fetch(`${uploadBase}?name=a.bin&upload_id=u-race&upload_token=up-tok`, {
      method: 'PUT',
      headers: { 'content-range': 'bytes 0-15/16' },
      body: chunkedBytes(16, 8),
    });
    await expectClosedEarlyAnswer(chunkedRace, 409, healthUrl);

    const chunkedUnsizedWhole = await fetch(`${uploadBase}?upload_id=s-new&upload_token=sess-tok`, {
      method: 'PUT',
      body: chunkedBytes(32 * 1024, 8 * 1024),
    });
    await expectClosedEarlyAnswer(chunkedUnsizedWhole, 411, healthUrl);
  });

  it('closes the connection when ownWriteRefusal rejects a live-mode upload before reading its body', async () => {
    const route = createStorageByteRoute({
      storage: {
        objectFile: async () => undefined,
        uploadProgress: async () => undefined,
        appendUpload: async () => ({ received: 0, size: 0 }),
      },
      sessionToken: 'tok',
      uploadToken: () => 'up-tok',
      ownWriteRefusal: () => Object.assign(new Error('Refused in live mode'), { code: 'PYRIC_LIVE_REFUSED' }),
    });
    const base = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void route(req, res, url).then((handled) => {
        if (!handled) res.writeHead(200).end('ok');
      });
    });

    const refused = await fetch(`${base}/__pyric/storage/v0/b/bkt/o?name=a&upload_id=u1&upload_token=up-tok`, {
      method: 'PUT',
      body: chunkedBytes(128 * 1024),
    });
    await expectClosedEarlyAnswer(refused, 403, `${base}/health`);
  });
});

describe('/__pyric/rate-captures early answers and 32 MB limit (#1721)', () => {
  it('answers 413 with JSON error and closes the connection past 32 MB without destroying the request stream', async () => {
    const dir = makeTempDir('pyric-rate-1721-');
    const store = createRateCaptureStore(dir);
    const base = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__pyric/init.json') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ rateCaptures: true }));
        return;
      }
      if (url.pathname === '/__pyric/rate-captures') {
        void handleRateCaptures(store, req, res, url);
        return;
      }
      res.writeHead(200).end('ok');
    });
    const endpoint = `${base}/__pyric/rate-captures`;
    const nextUrl = `${base}/health`;

    const oversized = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(RATE_CAPTURE_BODY_LIMIT_BYTES + 1024).fill(0x20),
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get('connection')).toBe('close');
    expect(await oversized.json()).toEqual({ error: 'Capture exceeds 32 MB.' });
    const afterFixed = await fetch(nextUrl);
    expect(afterFixed.status).toBe(200);
    await afterFixed.arrayBuffer();

    const chunked = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chunkedBytes(RATE_CAPTURE_BODY_LIMIT_BYTES + 64 * 1024, 256 * 1024),
    });
    await expectClosedEarlyAnswer(chunked, 413, nextUrl);

    const wrongMethod = await fetch(endpoint, {
      method: 'PUT',
      body: new Uint8Array(32 * 1024),
    });
    await expectClosedEarlyAnswer(wrongMethod, 405, nextUrl);

    const client = projectCaptures(((path: string, init?: RequestInit) => fetch(`${base}${path}`, init)) as typeof fetch);
    await expect(client.save(' '.repeat(RATE_CAPTURE_BODY_LIMIT_BYTES + 1))).rejects.toThrow('Capture exceeds 32 MB.');
  });
});

describe('/__pyric/state body limit and early answers (#1721)', () => {
  it('bounds POST bodies at STATE_BODY_LIMIT_BYTES with 413 and closes the connection on every early refusal', async () => {
    const dir = makeTempDir('pyric-state-1721-');
    const store = createStateStore(dir);
    const lock = createWriterLock();
    const base = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/__pyric/state') {
        void handleState(store, lock, req, res, url);
        return;
      }
      res.writeHead(200).end('ok');
    });
    const stateUrl = `${base}/__pyric/state`;
    const nextUrl = `${base}/health`;

    const badVersion = await fetch(`${stateUrl}?section=firestore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-writer': 'tab-a', 'x-pyric-state-version': 'bad' },
      body: chunkedBytes(64 * 1024),
    });
    await expectClosedEarlyAnswer(badVersion, 400, nextUrl);

    const badSection = await fetch(`${stateUrl}?section=invalid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-writer': 'tab-a' },
      body: chunkedBytes(64 * 1024),
    });
    await expectClosedEarlyAnswer(badSection, 400, nextUrl);

    const wrongMethod = await fetch(stateUrl, {
      method: 'PATCH',
      body: chunkedBytes(64 * 1024),
    });
    await expectClosedEarlyAnswer(wrongMethod, 405, nextUrl);

    // Claim lock for tab-a and advance version to 1 so tab-b gets 423 and stale version gets 409
    const validWrite = await fetch(`${stateUrl}?section=auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-writer': 'tab-a' },
      body: JSON.stringify({ users: [] }),
    });
    expect(validWrite.status).toBe(204);

    const lockedOut = await fetch(`${stateUrl}?section=auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-writer': 'tab-b' },
      body: chunkedBytes(64 * 1024),
    });
    await expectClosedEarlyAnswer(lockedOut, 423, nextUrl);

    const outdatedVersion = await fetch(`${stateUrl}?section=auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-writer': 'tab-a', 'x-pyric-state-version': '0' },
      body: chunkedBytes(64 * 1024),
    });
    await expectClosedEarlyAnswer(outdatedVersion, 409, nextUrl);

    // Reclaim lock for tab-a and send oversized body (> 32 MiB)
    const oversizedFixed = await fetch(`${stateUrl}?section=firestore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-writer': 'tab-a' },
      body: new Uint8Array(STATE_BODY_LIMIT_BYTES + 1024).fill(0x20),
    });
    await expectClosedEarlyAnswer(oversizedFixed, 413, nextUrl);

    const oversizedChunked = await fetch(`${stateUrl}?section=firestore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pyric-writer': 'tab-a' },
      body: chunkedBytes(STATE_BODY_LIMIT_BYTES + 64 * 1024, 256 * 1024),
    });
    await expectClosedEarlyAnswer(oversizedChunked, 413, nextUrl);
  });

  it('closes the connection when namespace refuses writes to host-owned /__pyric/state', async () => {
    const dir = makeTempDir('pyric-ns-1721-');
    const namespace = createPyricNamespace({
      sdkDir: dir,
      state: createStateStore(dir),
      stateOwner: 'host',
      initPayload: () => ({ rules: null, rulesHash: null, bridgeUrl: null }),
    });
    const base = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void Promise.resolve(namespace(req, res, url)).then((handled) => {
        if (!handled) res.writeHead(200).end('ok');
      });
    });

    const refused = await fetch(`${base}/__pyric/state?section=firestore`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pyric-session-token': namespace.sessionToken,
      },
      body: chunkedBytes(64 * 1024),
    });
    await expectClosedEarlyAnswer(refused, 423, `${base}/__pyric/health`);
  });
});
