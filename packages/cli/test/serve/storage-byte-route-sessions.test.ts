// Upload sessions on the byte route: the size comes from the first request,
// the object is committed when the last byte arrives, a slice without a total
// is refused, and the session answers only its own origin across origins.
import { afterEach, describe, expect, it } from 'bun:test';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { createStorageByteRoute, type UploadSessionView } from '../../src/serve/hosted/storage-byte-route.js';
import { UploadOffsetError, type UploadProgress } from '../../src/serve/hosted/persistence/storage.js';

const ORIGIN = 'http://localhost:3000';

interface Harness {
  base: string;
  sessionUrl: (token?: string) => string;
  finished: Array<{ sessionId: string; bytes: Uint8Array }>;
  opened: number[];
  route: ReturnType<typeof createStorageByteRoute>;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function harness(): Promise<Harness> {
  const uploads = new Map<string, { size: number; bytes: number[] }>();
  const session: UploadSessionView = { token: 'session-token', origin: ORIGIN };
  const finished: Harness['finished'] = [];
  const opened: number[] = [];
  const progressOf = (id: string): UploadProgress | undefined => {
    const upload = uploads.get(id);
    return upload && { received: upload.bytes.length, size: upload.size };
  };
  const route = createStorageByteRoute({
    sessionToken: undefined,
    uploadToken: () => undefined,
    storage: {
      async objectFile() { return undefined; },
      async uploadProgress(id) { return progressOf(id); },
      async appendUpload(id, offset, bytes) {
        const upload = uploads.get(id)!;
        if (offset !== upload.bytes.length) throw new UploadOffsetError(upload.bytes.length);
        if (upload.bytes.length + bytes.byteLength > upload.size) throw new Error('past the declared size');
        upload.bytes.push(...bytes);
        return progressOf(id)!;
      },
    },
    sessions: {
      get: id => (id === 's1' && finished.length === 0 ? session : undefined),
      async open(_id, size) {
        opened.push(size);
        uploads.set('u1', { size, bytes: [] });
        session.uploadId = 'u1';
        return 'u1';
      },
      async finish(sessionId) {
        finished.push({ sessionId, bytes: Uint8Array.from(uploads.get('u1')!.bytes) });
        return { bucket: 'demo-app-upload-staging', name: 'staging/u1/upload-1' };
      },
    },
  });
  const server = createServer((request, response) => {
    void route(request, response, new URL(request.url ?? '/', 'http://localhost'));
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const sessionUrl = (token = 'session-token') =>
    `${base}/__pyric/storage/v0/b/demo-app-upload-staging/o?name=staging%2Fu1%2Fupload-1&upload_id=s1&upload_token=${token}`;
  return { base, sessionUrl, finished, opened, route };
}

describe('byte route upload sessions', () => {
  it('takes the whole object in one PUT and commits it when the last byte arrives', async () => {
    const h = await harness();
    const response = await fetch(h.sessionUrl(), { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ bucket: 'demo-app-upload-staging', name: 'staging/u1/upload-1' });
    expect(h.opened).toEqual([4]);
    expect([...h.finished[0]!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('takes Content-Range slices whose first one names the total, and answers 308 until done', async () => {
    const h = await harness();
    const first = await fetch(h.sessionUrl(), { method: 'PUT', headers: { 'content-range': 'bytes 0-1/4' }, body: new Uint8Array([1, 2]) });
    expect(first.status).toBe(308);
    expect(first.headers.get('range')).toBe('bytes=0-1');
    expect(h.finished).toEqual([]);
    const rest = await fetch(h.sessionUrl(), { method: 'PUT', headers: { 'content-range': 'bytes 2-3/4' }, body: new Uint8Array([3, 4]) });
    expect(rest.status).toBe(200);
    expect([...h.finished[0]!.bytes]).toEqual([1, 2, 3, 4]);
  });

  it('refuses a first slice with an unknown total, and a total that contradicts the session', async () => {
    const h = await harness();
    const unknown = await fetch(h.sessionUrl(), { method: 'PUT', headers: { 'content-range': 'bytes 0-1/*' }, body: new Uint8Array([1, 2]) });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toMatch(/must name the total size/);
    expect(h.opened).toEqual([]);
    await fetch(h.sessionUrl(), { method: 'PUT', headers: { 'content-range': 'bytes 0-1/4' }, body: new Uint8Array([1, 2]) });
    const contradicting = await fetch(h.sessionUrl(), { method: 'PUT', headers: { 'content-range': 'bytes 2-3/9' }, body: new Uint8Array([3, 4]) });
    expect(contradicting.status).toBe(400);
    expect(h.finished).toEqual([]);
  });

  it('refuses the wrong token and answers only the session origin across origins', async () => {
    const h = await harness();
    expect((await fetch(h.sessionUrl('wrong'), { method: 'PUT', body: new Uint8Array([1]) })).status).toBe(403);

    const preflight = await fetch(h.sessionUrl(), {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
    const otherOrigin = await fetch(h.sessionUrl(), { method: 'OPTIONS', headers: { origin: 'http://evil.test' } });
    expect(otherOrigin.status).toBe(403);

    const put = await fetch(h.sessionUrl(), { method: 'PUT', headers: { origin: ORIGIN }, body: new Uint8Array([9]) });
    expect(put.status).toBe(200);
    expect(put.headers.get('access-control-allow-origin')).toBe(ORIGIN);

    const url = new URL(h.sessionUrl());
    expect(h.route.allowsOrigin(url, 'http://evil.test')).toBe(false);
  });

  it('allows the session origin through the host guard only with the session token', async () => {
    const h = await harness();
    expect(h.route.allowsOrigin(new URL(h.sessionUrl()), ORIGIN)).toBe(true);
    expect(h.route.allowsOrigin(new URL(h.sessionUrl('wrong')), ORIGIN)).toBe(false);
    expect(h.route.allowsOrigin(new URL(`${h.base}/__pyric/storage/v0/b/x/o/a.txt?alt=media`), ORIGIN)).toBe(false);
  });
});
