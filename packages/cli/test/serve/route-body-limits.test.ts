import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityIncident } from 'pyric/firestore/internal';
import {
  ACTIVITY_BODY_LIMIT_BYTES,
  handleActivity,
} from '../../src/serve/activity-route.js';
import {
  CAPTURE_BODY_LIMIT_BYTES,
  handleCapture,
} from '../../src/serve/state-capture-route.js';
import {
  createStudioRoutes,
  diskProjectStore,
  diskWorkspace,
} from '../../src/serve/studio/index.js';
import {
  STUDIO_PROJECT_BODY_LIMIT_BYTES,
  STUDIO_WORKSPACE_BODY_LIMIT_BYTES,
} from '../../src/serve/studio/routes.js';
import { createWriterLock } from '../../src/serve/writer-lock.js';
import { expectClosedEarlyAnswer } from './early-answer.js';

const SECRET_TOKEN = 'm4-body-limits-session-token-0123456789';
const ACTIVITY_TOKEN = 'm4-body-limits-activity-token-0123456789';

const servers: Server[] = [];
const tempDirs: string[] = [];

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

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function listenLoopback(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

function chunkedBytes(payload: Uint8Array, chunkSize = 16 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= payload.byteLength) {
        controller.close();
        return;
      }
      const next = Math.min(chunkSize, payload.byteLength - offset);
      controller.enqueue(payload.subarray(offset, offset + next));
      offset += next;
    },
  });
}

function multibyteJsonOverLimit(limitBytes: number, key = 'title'): {
  text: string;
  bytes: Uint8Array;
} {
  const emoji = String.fromCodePoint(0x1f600);
  const count = Math.ceil((limitBytes + 64) / 4);
  const text = JSON.stringify({ [key]: emoji.repeat(count) });
  const bytes = new TextEncoder().encode(text);
  expect(text.length).toBeLessThan(limitBytes);
  expect(bytes.byteLength).toBeGreaterThan(limitBytes);
  return { text, bytes };
}

describe('Studio routes bounded HTTP request body limits (413)', () => {
  it('enforces STUDIO_PROJECT_BODY_LIMIT_BYTES on fixed, chunked, and multi-byte UTF-8 payloads', async () => {
    const dir = makeTempDir('pyric-m4-studio-proj-limit-');
    const routes = createStudioRoutes({
      projects: diskProjectStore(join(dir, '.pyric', 'projects')),
      sessionToken: SECRET_TOKEN,
      writerLock: createWriterLock(),
      boundHost: '127.0.0.1',
    });
    const { baseUrl } = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/health') {
        res.writeHead(200).end('ok');
        return;
      }
      void routes(req, res, url).then((handled) => {
        if (!handled) res.writeHead(404).end('not found');
      });
    });

    const authHeaders = {
      'content-type': 'application/json',
      'x-pyric-session-token': SECRET_TOKEN,
      'x-pyric-writer': 'tab-1',
    };

    const createdRes = await fetch(`${baseUrl}/__pyric/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'Bounded App' }),
    });
    expect(createdRes.status).toBe(200);
    const created = (await createdRes.json()) as { id: string };

    const oversizedFixed = await fetch(`${baseUrl}/__pyric/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title: 'a'.repeat(STUDIO_PROJECT_BODY_LIMIT_BYTES + 128) }),
    });
    await expectClosedEarlyAnswer(oversizedFixed, 413, `${baseUrl}/health`);

    const chunkedPayload = new TextEncoder().encode(
      JSON.stringify({ title: 'b'.repeat(STUDIO_PROJECT_BODY_LIMIT_BYTES + 4096) }),
    );
    const oversizedChunked = await fetch(`${baseUrl}/__pyric/projects`, {
      method: 'POST',
      headers: authHeaders,
      body: chunkedBytes(chunkedPayload, 4096),
    });
    await expectClosedEarlyAnswer(oversizedChunked, 413, `${baseUrl}/health`);

    const multiByte = multibyteJsonOverLimit(STUDIO_PROJECT_BODY_LIMIT_BYTES);
    const oversizedMultiByte = await fetch(`${baseUrl}/__pyric/projects/${created.id}`, {
      method: 'PATCH',
      headers: authHeaders,
      body: chunkedBytes(multiByte.bytes, 4096),
    });
    await expectClosedEarlyAnswer(oversizedMultiByte, 413, `${baseUrl}/health`);
  });

  it('enforces STUDIO_WORKSPACE_BODY_LIMIT_BYTES on PUT /__pyric/workspace without writing oversized files', async () => {
    const dir = makeTempDir('pyric-m4-studio-ws-limit-');
    const routes = createStudioRoutes({
      workspace: diskWorkspace(dir),
      sessionToken: SECRET_TOKEN,
      writerLock: createWriterLock(),
      boundHost: '127.0.0.1',
    });
    const { baseUrl } = await listenLoopback((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/health') {
        res.writeHead(200).end('ok');
        return;
      }
      void routes(req, res, url).then((handled) => {
        if (!handled) res.writeHead(404).end('not found');
      });
    });

    const authHeaders = {
      'x-pyric-session-token': SECRET_TOKEN,
      'x-pyric-writer': 'tab-1',
    };

    const sampleUtf8 = 'hello-world-\u{1f600}';
    const okWrite = await fetch(`${baseUrl}/__pyric/workspace?path=ok.txt`, {
      method: 'PUT',
      headers: authHeaders,
      body: sampleUtf8,
    });
    expect(okWrite.status).toBe(204);
    expect(readFileSync(join(dir, 'ok.txt'), 'utf8')).toBe(sampleUtf8);

    const oversizedFixed = await fetch(`${baseUrl}/__pyric/workspace?path=too-big.txt`, {
      method: 'PUT',
      headers: authHeaders,
      body: new Uint8Array(STUDIO_WORKSPACE_BODY_LIMIT_BYTES + 1024).fill(0x61),
    });
    await expectClosedEarlyAnswer(oversizedFixed, 413, `${baseUrl}/health`);
    expect(existsSync(join(dir, 'too-big.txt'))).toBe(false);

    const oversizedChunked = await fetch(`${baseUrl}/__pyric/workspace?path=too-big-chunked.txt`, {
      method: 'PUT',
      headers: authHeaders,
      body: chunkedBytes(
        new Uint8Array(STUDIO_WORKSPACE_BODY_LIMIT_BYTES + 64 * 1024).fill(0x62),
        256 * 1024,
      ),
    });
    await expectClosedEarlyAnswer(oversizedChunked, 413, `${baseUrl}/health`);
    expect(existsSync(join(dir, 'too-big-chunked.txt'))).toBe(false);
  });
});

describe('Activity & State-Capture bounded HTTP body limits (413)', () => {
  it('rejects chunked multi-byte UTF-8 activity payloads exceeding ACTIVITY_BODY_LIMIT_BYTES', async () => {
    const received: ActivityIncident[] = [];
    const { baseUrl } = await listenLoopback((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200).end('ok');
        return;
      }
      void handleActivity((inc) => received.push(inc), req, res, ACTIVITY_TOKEN);
    });

    const multiByte = multibyteJsonOverLimit(ACTIVITY_BODY_LIMIT_BYTES, 'padding');
    const response = await fetch(`${baseUrl}/__pyric/activity`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        'x-pyric-activity-token': ACTIVITY_TOKEN,
      },
      body: chunkedBytes(multiByte.bytes, 2048),
    });
    await expectClosedEarlyAnswer(response, 413, `${baseUrl}/health`);
    expect(received).toEqual([]);
  });

  it('stores valid /__pyric/capture verbatim and rejects oversized fixed, chunked, and multi-byte UTF-8 bodies with 413', async () => {
    let saved: string | null = null;
    let writeCount = 0;
    const capture = {
      write(json: string) {
        writeCount += 1;
        saved = json;
      },
      read() {
        return saved;
      },
    };
    const { baseUrl } = await listenLoopback((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200).end('ok');
        return;
      }
      void handleCapture(capture, req, res);
    });

    const validPayload = JSON.stringify({ events: [{ id: 'e1', label: 'ok-\u{1f600}' }] });
    const okPost = await fetch(`${baseUrl}/__pyric/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validPayload,
    });
    expect(okPost.status).toBe(204);
    expect(writeCount).toBe(1);

    const okGet = await fetch(`${baseUrl}/__pyric/capture`);
    expect(okGet.status).toBe(200);
    expect(await okGet.text()).toBe(validPayload);

    const oversizedFixed = await fetch(`${baseUrl}/__pyric/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(CAPTURE_BODY_LIMIT_BYTES + 1024).fill(0x20),
    });
    await expectClosedEarlyAnswer(oversizedFixed, 413, `${baseUrl}/health`);
    expect(writeCount).toBe(1);

    const oversizedChunked = await fetch(`${baseUrl}/__pyric/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chunkedBytes(
        new Uint8Array(CAPTURE_BODY_LIMIT_BYTES + 64 * 1024).fill(0x20),
        256 * 1024,
      ),
    });
    await expectClosedEarlyAnswer(oversizedChunked, 413, `${baseUrl}/health`);
    expect(writeCount).toBe(1);

    const emoji = String.fromCodePoint(0x1f600);
    const repeatCount = Math.ceil((CAPTURE_BODY_LIMIT_BYTES + 1024) / 4);
    const utf8Text = emoji.repeat(repeatCount);
    const utf8Bytes = new TextEncoder().encode(utf8Text);
    expect(utf8Text.length).toBeLessThan(CAPTURE_BODY_LIMIT_BYTES);
    expect(utf8Bytes.byteLength).toBeGreaterThan(CAPTURE_BODY_LIMIT_BYTES);

    const oversizedMultiByte = await fetch(`${baseUrl}/__pyric/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: chunkedBytes(utf8Bytes, 256 * 1024),
    });
    await expectClosedEarlyAnswer(oversizedMultiByte, 413, `${baseUrl}/health`);
    expect(writeCount).toBe(1);
    expect(saved).toBe(validPayload);
  });
});
