// The provider forwarder against a fake TLS upstream, through its upstream
// seam: what it lets through and with which key, what it refuses and why,
// and the ledger that caps the spend across a restart. The key is a
// sentinel; no test reaches a real provider.
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Listening } from '../model-channel.ts';
import { PLACEHOLDER_KEY, startProviderForwarder, type ProviderCall } from './provider-forwarder.ts';
import { openProviderLedger, type CallerKind, type LedgerLine, type ProviderLedger } from './provider-ledger.ts';
import { PROVIDER_HOST } from './provider-prices.ts';

const SENTINEL_KEY = 'sentinel-provider-key-not-real';
const IMAGE_MODEL = 'gemini-nano-banana-2.1';
const IMAGE_PATH = `/v1beta/models/${IMAGE_MODEL}:generateContent`;

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

interface FakeTlsUpstream {
  port: number;
  ca: string;
  received: Received[];
  /** Send the headers and part of the body, then drop the connection. */
  cutOff: boolean;
  close(): Promise<void>;
}

let certDir = '';
let cert = '';
let key = '';

beforeAll(() => {
  certDir = mkdtempSync(join(tmpdir(), 'factory-provider-cert-'));
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${PROVIDER_HOST}`,
    '-addext', `subjectAltName=DNS:${PROVIDER_HOST}`,
    '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'),
  ], { stdio: 'ignore' });
  cert = readFileSync(join(certDir, 'cert.pem'), 'utf8');
  key = readFileSync(join(certDir, 'key.pem'), 'utf8');
});

async function startFakeTlsUpstream(): Promise<FakeTlsUpstream> {
  const fake: FakeTlsUpstream = { port: 0, ca: cert, received: [], cutOff: false, close: async () => {} };
  const server = https.createServer({ key, cert }, (request, response) => {
    request.resume();
    request.on('end', () => {
      fake.received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers });
      if (fake.cutOff) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '100000' });
        response.write('{"candidates":[{"content":');
        setTimeout(() => response.socket?.destroy(), 20);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=1', location: 'https://elsewhere.invalid/' });
      response.end(JSON.stringify({ name: 'interactions/abc', done: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.port = (server.address() as AddressInfo).port;
  fake.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fake;
}

const open: Array<Listening | FakeTlsUpstream> = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((item) => item.close()));
});

interface Rig {
  dir: string;
  socket: string;
  calls: string;
  spend: string;
  upstream: FakeTlsUpstream;
  ledger: ProviderLedger;
}

interface RigOptions {
  capUsd?: number;
  sessionCapUsd?: number;
  caller?: CallerKind;
  dir?: string;
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'factory-provider-'));
  const spend = join(dir, 'spend.jsonl');
  const calls = join(dir, 'calls.jsonl');
  const upstream = await startFakeTlsUpstream();
  const ledger = openProviderLedger({ path: spend, capUsd: options.capUsd ?? 50, callerCapsUsd: options.sessionCapUsd === undefined ? {} : { session: options.sessionCapUsd } });
  const socket = join(dir, `${options.caller ?? 'served'}-${Math.random().toString(36).slice(2)}.sock`);
  const forwarder = await startProviderForwarder({
    socketPath: socket, caller: options.caller ?? 'served', ledger, calls,
    credential: () => ({ ok: true, key: SENTINEL_KEY }),
    upstream: { host: '127.0.0.1', port: upstream.port, tls: true, ca: upstream.ca },
  });
  open.push(upstream, forwarder);
  return { dir, socket, calls, spend, upstream, ledger };
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  cut: boolean;
}

function call(socketPath: string, method: string, path: string, body?: unknown): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path, headers: { 'content-type': 'application/json', 'x-goog-api-key': PLACEHOLDER_KEY, cookie: 'c=1' } }, (response) => {
      const chunks: Buffer[] = [];
      const done = (cut: boolean) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), cut });
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => done(false));
      response.on('error', () => done(true));
      response.on('aborted', () => done(true));
    });
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const image = (socket: string, query = '') => call(socket, 'POST', `${IMAGE_PATH}${query}`, { contents: [{ parts: [{ text: 'a lighthouse' }] }] });

function readCalls(path: string): ProviderCall[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ProviderCall);
}

function readLedger(path: string): LedgerLine[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as LedgerLine);
}

describe('allowed calls', () => {
  test('an image call reaches the fixed host with the real key, never the placeholder or a key in the query', async () => {
    const { socket, upstream, ledger } = await rig();
    const answer = await image(socket, '?key=from-the-sandbox&alt=json');
    expect(answer.status).toBe(200);
    expect(answer.headers['set-cookie']).toBeUndefined();
    expect(answer.headers.location).toBeUndefined();
    expect(upstream.received).toHaveLength(1);
    const [sent] = upstream.received;
    expect(sent?.headers['x-goog-api-key']).toBe(SENTINEL_KEY);
    expect(sent?.headers.host).toBe(PROVIDER_HOST);
    expect(sent?.headers.cookie).toBeUndefined();
    expect(sent?.url).toBe(`${IMAGE_PATH}?alt=json`);
    expect(ledger.spentUsd()).toBeCloseTo(0.134);
  });

  test('a music interaction is charged and its polling is free', async () => {
    const { socket, upstream, ledger } = await rig();
    expect((await call(socket, 'POST', '/v1beta/interactions', { model: 'models/lyria-3.5', input: 'a calm tune' })).status).toBe(200);
    expect((await call(socket, 'GET', '/v1beta/interactions/abc')).status).toBe(200);
    expect(upstream.received.map((sent) => [sent.method, sent.url])).toEqual([['POST', '/v1beta/interactions'], ['GET', '/v1beta/interactions/abc']]);
    expect(ledger.spentUsd()).toBeCloseTo(1);
  });
});

describe('refusals', () => {
  test('a video path, an unknown model and model listing are refused with their reason and never reach upstream', async () => {
    const { socket, upstream, calls } = await rig();
    const answers = [
      await call(socket, 'POST', '/v1beta/models/veo-3.1-generate-preview:predictLongRunning', {}),
      await call(socket, 'POST', '/v1beta/interactions', { model: 'veo-3.1-generate-preview' }),
      await call(socket, 'POST', '/v1beta/models/gemini-nano-banana-2.1-pro:generateContent', {}),
      await call(socket, 'GET', '/v1beta/models'),
      await call(socket, 'POST', '/upload/v1beta/files', {}),
      await call(socket, 'GET', IMAGE_PATH),
      await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5', stream: true }),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(['path', 'model', 'model', 'path', 'path', 'method', 'streaming']);
    expect(upstream.received).toEqual([]);
  });

  test('with $0.05 left a $0.134 image is refused and the upstream sees nothing', async () => {
    const { socket, upstream, ledger, calls } = await rig({ capUsd: 0.2 });
    const earlier = ledger.reserve('served', 'gemini-3.5-flash-lite', 0.15);
    if (typeof earlier === 'string') throw new Error(`the earlier spend was refused (${earlier})`);
    earlier.settle('complete');
    const answer = await image(socket);
    expect(answer.status).toBe(429);
    expect(JSON.parse(answer.body).error.status).toBe('RESOURCE_EXHAUSTED');
    expect(answer.body).toContain('factory provider budget reached');
    expect(upstream.received).toEqual([]);
    expect(readCalls(calls)[0]?.reason).toBe('run-cap');
    expect(ledger.spentUsd()).toBeCloseTo(0.15);
  });

  test('sessions stop at their sub-cap while the served copy still spends the shared cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-provider-'));
    const session = await rig({ dir, capUsd: 1, sessionCapUsd: 0.3, caller: 'session' });
    expect((await image(session.socket)).status).toBe(200);
    expect((await image(session.socket)).status).toBe(200);
    expect((await image(session.socket)).status).toBe(429);
    expect(readCalls(session.calls).map((line) => line.reason)).toEqual([null, null, 'caller-cap']);
    const served = await startProviderForwarder({
      socketPath: join(dir, 'served.sock'), caller: 'served', ledger: session.ledger, calls: session.calls,
      credential: () => ({ ok: true, key: SENTINEL_KEY }),
      upstream: { host: '127.0.0.1', port: session.upstream.port, tls: true, ca: session.upstream.ca },
    });
    open.push(served);
    expect((await image(join(dir, 'served.sock'))).status).toBe(200);
    expect(session.ledger.spentBy('session')).toBeCloseTo(0.268);
    expect(session.ledger.spentBy('served')).toBeCloseTo(0.134);
    expect(session.ledger.spentUsd()).toBeCloseTo(0.402);
  });
});

describe('the ledger', () => {
  test('a response cut off mid-stream keeps its reservation', async () => {
    const { socket, upstream, ledger, spend } = await rig();
    upstream.cutOff = true;
    const answer = await image(socket);
    expect(answer.cut).toBe(true);
    expect(ledger.spentUsd()).toBeCloseTo(0.134);
    expect(ledger.inFlight()).toBe(0);
    const settle = readLedger(spend).find((line) => line.type === 'settle');
    expect(settle?.type === 'settle' ? [settle.usd, settle.outcome] : null).toEqual([0.134, 'cut-off']);
  });

  test('after a restart an unsettled reservation still counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-provider-'));
    const path = join(dir, 'spend.jsonl');
    const before = openProviderLedger({ path, capUsd: 0.2 });
    expect(typeof before.reserve('served', IMAGE_MODEL, 0.134)).toBe('object');
    const { socket, upstream, ledger } = await rig({ dir, capUsd: 0.2 });
    expect(ledger.spentUsd()).toBeCloseTo(0.134);
    expect(ledger.inFlight()).toBe(0);
    expect((await image(socket)).status).toBe(429);
    expect(upstream.received).toEqual([]);
  });

  test('a corrupt ledger refuses every billable call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-provider-'));
    writeFileSync(join(dir, 'spend.jsonl'), '{"type":"reserve","id":"a"\n');
    const { socket, upstream, ledger, calls } = await rig({ dir });
    expect(ledger.problem()).toContain('line 1');
    expect((await image(socket)).status).toBe(503);
    expect((await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5' })).status).toBe(503);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(['ledger-unreadable', 'ledger-unreadable']);
    expect(upstream.received).toEqual([]);
  });
});

describe('the calls record', () => {
  test('holds neither the key nor the query string', async () => {
    const { socket, calls } = await rig();
    await image(socket, '?key=query-secret-value&alt=json');
    await call(socket, 'GET', '/v1beta/models?key=query-secret-value');
    const text = readFileSync(calls, 'utf8');
    expect(text).not.toContain(SENTINEL_KEY);
    expect(text).not.toContain(PLACEHOLDER_KEY);
    expect(text).not.toContain('query-secret-value');
    expect(text).not.toContain('?');
    expect(readCalls(calls).map((line) => [line.path, line.action, line.chargedUsd])).toEqual([[IMAGE_PATH, 'forwarded', 0.134], ['/v1beta/models', 'refused', 0]]);
  });
});
