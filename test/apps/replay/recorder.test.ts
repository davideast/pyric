/**
 * The recorder makes a recorded-exchange file from a real run. Here the run's
 * "production" is a replay server, so the test stays offline: the real SDK
 * talks to the recorder, the recorder forwards to the replay server, and the
 * file it returns must hold shapes only and answer the same calls when
 * replayed on its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ListenExchange, Recording, WriteExchange } from './format.ts';
import { startRecorder } from './recorder.ts';
import { passThroughFetch, routeFirebaseTo } from './seam.ts';
import { loadSdk, type Sdk } from './sdk.ts';
import { readRecording } from './format.ts';
import { readBody, startReplayServer, type ReplayServer } from './server.ts';
import { chunk, splitChunks } from './webchannel.ts';

const ROOMS = join(import.meta.dir, 'fixtures', 'rooms.json');
const CONFIG = { projectId: 'demo-replay', apiKey: 'test-api-key', appId: '1:1:web:recorder', authDomain: 'demo-replay.firebaseapp.com' };

let sdk: Sdk;
let apps = 0;
let upstream: ReplayServer;
let recorded: Recording;

/** The app code a scenario would run: sign in, read, a denied read, a listener and a write from a second client. */
async function run(): Promise<{ lobby: unknown; denied: string; rooms: string[][] }> {
  const { app, auth, firestore } = sdk;
  const open = async () => {
    apps += 1;
    const instance = app.initializeApp(CONFIG, `recorder-${apps}`);
    await auth.signInWithEmailAndPassword(auth.getAuth(instance), 'reader@example.com', 'test-password');
    return firestore.getFirestore(instance);
  };
  const db = await open();
  const lobby = (await firestore.getDoc(firestore.doc(db, 'rooms/lobby'))).data();
  const denied = await firestore.getDoc(firestore.doc(db, 'rooms/secret')).then(() => 'allowed', (error: { code: string }) => error.code);
  const rooms: string[][] = [];
  const stop = firestore.onSnapshot(
    firestore.query(firestore.collection(db, 'rooms'), firestore.where('open', '==', true)),
    { includeMetadataChanges: true },
    (snapshot) => {
      if (!snapshot.metadata.fromCache) rooms.push(snapshot.docs.map((room) => room.id));
    },
  );
  await waitFor(() => rooms.length === 1);
  const writer = await open();
  await firestore.setDoc(firestore.doc(writer, 'rooms/garden'), { name: 'Garden', open: true });
  await waitFor(() => rooms.length === 2);
  stop();
  return { lobby, denied, rooms };
}

beforeAll(async () => {
  upstream = await startReplayServer([readRecording(ROOMS)]);
  const recorder = await startRecorder({ project: 'demo-replay', source: 'recorder test', upstream: (host) => `${upstream.origin}/${host}` });
  const stopRouting = routeFirebaseTo(recorder.origin);
  sdk = await loadSdk();
  await run();
  for (const app of sdk.app.getApps()) await sdk.app.deleteApp(app);
  recorded = await recorder.stop();
  stopRouting();
  await upstream.close();
});

afterAll(async () => {
  for (const app of sdk.app.getApps()) await sdk.app.deleteApp(app);
});

describe('a recording made by the recorder', () => {
  test('holds the calls the run made', () => {
    const kinds = recorded.exchanges.map((exchange) => exchange.kind === 'auth' ? `auth ${exchange.request.path}` : exchange.kind);
    expect(kinds).toContain('auth /v1/accounts:signInWithPassword');
    expect(kinds).toContain('auth /v1/accounts:lookup');
    expect(kinds.filter((kind) => kind === 'listen')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'write')).toHaveLength(1);
  });

  test('keeps no token, password or server time', () => {
    const text = JSON.stringify(recorded);
    expect(text).not.toContain('test-password');
    expect(text).not.toContain('eyJ');
    expect(text).not.toContain(Buffer.from('replay-').toString('base64').slice(0, 8));
    expect(text).not.toContain('"readTime":"');
  });

  test('ties the listener batch the write released to that write', () => {
    const write = recorded.exchanges.find((exchange): exchange is WriteExchange => exchange.kind === 'write')!;
    const listener = recorded.exchanges.find((exchange): exchange is ListenExchange => exchange.kind === 'listen' && 'query' in exchange.target)!;
    expect(listener.batches.map((batch) => batch.after)).toEqual([undefined, write.id]);
    expect(JSON.stringify(listener.batches[1])).toContain('{"$":"commitTime"}');
  });

  test('answers the same run when replayed on its own', async () => {
    const replay = await startReplayServer([recorded]);
    const stopRouting = routeFirebaseTo(replay.origin);
    try {
      const outcome = await run();
      expect(outcome).toEqual({ lobby: { name: 'Lobby', open: true, seats: 12 }, denied: 'permission-denied', rooms: [['lobby'], ['garden', 'lobby']] });
      expect(replay.unmatched).toEqual([]);
    } finally {
      stopRouting();
      await replay.close();
    }
  });

  test('keeps the first listener batch intact when an earlier target global readTime arrives after addTarget', async () => {
    const server = await startReplayServer([readRecording(ROOMS)]);
    // Split every WebChannel back-channel array into its own chunk with a brief pause
    // after a target REMOVE with cause, so the SDK sends the next addTarget before the
    // denied read's trailing global readTime reaches the recorder.
    const splitter = createServer(async (request, response) => {
      const body = await readBody(request);
      const abort = new AbortController();
      request.on('close', () => abort.abort());
      try {
        const answer = await passThroughFetch(`${server.origin}${request.url}`, {
          method: request.method,
          headers: request.headers as Record<string, string>,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
          signal: abort.signal,
        });
        response.writeHead(answer.status, Object.fromEntries(answer.headers.entries()));
        if (answer.body) {
          const decoder = new TextDecoder();
          let buffer = '';
          for await (const part of answer.body) {
            buffer += decoder.decode(part, { stream: true });
            const { payloads, rest } = splitChunks(buffer);
            buffer = rest;
            for (const payload of payloads) {
              if (Array.isArray(payload) && Array.isArray(payload[0])) {
                for (const item of payload as Array<[number, unknown[]]>) {
                  response.write(chunk([item]));
                  const first = item[1][0] as { targetChange?: { targetChangeType?: string; cause?: unknown } } | undefined;
                  if (first?.targetChange?.targetChangeType === 'REMOVE' && first.targetChange.cause) {
                    await new Promise((resolve) => setTimeout(resolve, 40));
                  }
                }
              } else {
                response.write(chunk(payload));
              }
            }
          }
          if (buffer) response.write(buffer);
        }
        response.end();
      } catch {
        if (!response.writableEnded) response.end();
      }
    });
    await new Promise<void>((resolve) => splitter.listen(0, '127.0.0.1', resolve));
    const { port } = splitter.address() as AddressInfo;
    const recorder = await startRecorder({ project: 'demo-replay', source: 'chunk-split test', upstream: (host) => `http://127.0.0.1:${port}/${host}` });
    const stopRouting = routeFirebaseTo(recorder.origin);
    let splitRecording: Recording;
    try {
      await run();
      for (const app of sdk.app.getApps()) await sdk.app.deleteApp(app);
      splitRecording = await recorder.stop();
    } finally {
      stopRouting();
      splitter.closeAllConnections();
      await new Promise<void>((resolve) => splitter.close(() => resolve()));
      await server.close();
    }
    const write = splitRecording.exchanges.find((exchange): exchange is WriteExchange => exchange.kind === 'write')!;
    const listener = splitRecording.exchanges.find((exchange): exchange is ListenExchange => exchange.kind === 'listen' && 'query' in exchange.target)!;
    expect(listener.batches.map((batch) => batch.after)).toEqual([undefined, write.id]);
    const replay = await startReplayServer([splitRecording]);
    const stopReplayRouting = routeFirebaseTo(replay.origin);
    try {
      const outcome = await run();
      expect(outcome).toEqual({ lobby: { name: 'Lobby', open: true, seats: 12 }, denied: 'permission-denied', rooms: [['lobby'], ['garden', 'lobby']] });
      expect(replay.unmatched).toEqual([]);
    } finally {
      for (const app of sdk.app.getApps()) await sdk.app.deleteApp(app);
      stopReplayRouting();
      await replay.close();
    }
  });

  test('decodes a resent back-channel array once across reconnects', async () => {
    const sid = 'session-reconnect-test';
    const message = { targetChange: { targetChangeType: 'ADD', targetIds: [2] } };
    const mockUpstream = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://upstream.invalid');
      if (request.method === 'POST' && !url.searchParams.get('SID')) {
        response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        response.end(chunk([[0, ['c', sid, '', 8, 14, 30_000]]]));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      // Both back-channel GETs deliver array id 1 (as when a reconnect resends an unacknowledged array).
      response.end(chunk([[1, [message]]]));
    });
    await new Promise<void>((resolve) => mockUpstream.listen(0, '127.0.0.1', resolve));
    const { port } = mockUpstream.address() as AddressInfo;
    const recorder = await startRecorder({ project: 'demo-replay', source: 'reconnect test', upstream: (host) => `http://127.0.0.1:${port}/${host}` });
    try {
      const target = { documents: { documents: ['projects/demo-replay/databases/(default)/documents/rooms/lobby'] } };
      const body = new URLSearchParams({
        count: '1',
        ofs: '0',
        req0___data__: JSON.stringify({ addTarget: { targetId: 2, ...target } }),
      }).toString();
      const base = `${recorder.origin}/firestore.googleapis.com/google.firestore.v1.Firestore/Listen/channel`;
      await (await passThroughFetch(base, { method: 'POST', body })).text();
      await (await passThroughFetch(`${base}?SID=${sid}&AID=0&RID=rpc&TYPE=xmlhttp`, { method: 'GET' })).text();
      await (await passThroughFetch(`${base}?SID=${sid}&AID=0&RID=rpc&TYPE=xmlhttp`, { method: 'GET' })).text();
      const recording = await recorder.stop();
      const listener = recording.exchanges.find((exchange): exchange is ListenExchange => exchange.kind === 'listen')!;
      expect(listener.batches[0]!.messages).toHaveLength(1);
    } finally {
      mockUpstream.closeAllConnections();
      await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
    }
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
