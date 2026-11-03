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
import { IMAGE_PART_TOKENS, priceOf, PROVIDER_HOST, worstCaseUsd } from './provider-prices.ts';

const SENTINEL_KEY = 'sentinel-provider-key-not-real';
const IMAGE_MODEL = 'gemini-nano-banana-2.1';
const IMAGE_PATH = `/v1beta/models/${IMAGE_MODEL}:generateContent`;

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
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
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      fake.received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
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
  /** The key `credential()` reads; the sentinel by default. */
  key?: string;
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
    credential: () => ({ ok: true, key: options.key ?? SENTINEL_KEY }),
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

function call(socketPath: string, method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method, path, headers: { 'content-type': contentType, 'x-goog-api-key': PLACEHOLDER_KEY, cookie: 'c=1' } }, (response) => {
      const chunks: Buffer[] = [];
      const done = (cut: boolean) => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8'), cut });
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => done(false));
      response.on('error', () => done(true));
      response.on('aborted', () => done(true));
    });
    request.on('error', reject);
    // A string is sent as it is, to test bodies JSON.stringify can't make.
    request.end(body === undefined || typeof body === 'string' ? body : JSON.stringify(body));
  });
}

/** The worst-case price each image call reserves. */
const IMAGE_USD = 1.06;
const OUTPUT = { maxOutputTokens: 1024 };
const MUSIC_OUTPUT = { max_output_tokens: 1024 };

const image = (socket: string, query = '') => call(socket, 'POST', `${IMAGE_PATH}${query}`, { contents: [{ parts: [{ text: 'a lighthouse' }] }], generationConfig: OUTPUT });

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
    expect(sent?.url).toBe(IMAGE_PATH);
    expect(ledger.spentUsd()).toBeCloseTo(IMAGE_USD);
  });

  test('a music interaction is charged and its polling is free', async () => {
    const { socket, upstream, ledger } = await rig();
    expect((await call(socket, 'POST', '/v1beta/interactions', { model: 'models/lyria-3.5', input: 'a calm tune', generation_config: MUSIC_OUTPUT })).status).toBe(200);
    expect((await call(socket, 'GET', '/v1beta/interactions/abc')).status).toBe(200);
    expect(upstream.received.map((sent) => [sent.method, sent.url])).toEqual([['POST', '/v1beta/interactions'], ['GET', '/v1beta/interactions/abc']]);
    expect(ledger.spentUsd()).toBeCloseTo(1.06);
  });
});

describe('what is sent on', () => {
  test('a body with a duplicate model key is sent as checked, naming only the allowed model', async () => {
    const { socket, upstream } = await rig();
    const answer = await call(socket, 'POST', '/v1beta/interactions', '{"model":"veo-3.1-generate-preview","model":"lyria-3.5","input":"a calm tune","generation_config":{"max_output_tokens":1024}}');
    expect(answer.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    expect(JSON.parse(upstream.received[0]?.body ?? '')).toEqual({ model: 'lyria-3.5', input: 'a calm tune', generation_config: MUSIC_OUTPUT });
    expect(upstream.received[0]?.body).not.toContain('veo');
    expect(upstream.received[0]?.headers['content-length']).toBe(String(Buffer.byteLength(upstream.received[0]?.body ?? '')));
  });

  test('no query string reaches upstream, on any route', async () => {
    const { socket, upstream } = await rig();
    await image(socket, '?alt=sse&$httpMethod=DELETE');
    await call(socket, 'POST', '/v1beta/interactions?alt=sse&$httpMethod=DELETE', { model: 'lyria-3.5', generation_config: MUSIC_OUTPUT });
    await call(socket, 'GET', '/v1beta/interactions/abc?alt=sse&$httpMethod=DELETE');
    expect(upstream.received.map((sent) => sent.url)).toEqual([IMAGE_PATH, '/v1beta/interactions', '/v1beta/interactions/abc']);
  });
});

describe('refusals', () => {
  test('a body field that could cost more than one call is refused and never reaches upstream', async () => {
    const { socket, upstream, calls } = await rig();
    const text = [{ parts: [{ text: 'a lighthouse' }] }];
    const bodies: unknown[] = [
      { contents: text, generationConfig: { candidateCount: 8 } },
      { contents: text, generationConfig: { imageConfig: { imageSize: '4K' } } },
      { contents: text, tools: [{ googleSearch: {} }] },
      { contents: text, toolConfig: {} },
      { contents: text, cachedContent: 'cachedContents/abc' },
      { contents: [{ parts: [{ fileData: { fileUri: 'https://example.invalid/f', mimeType: 'image/png' } }] }] },
      { contents: [{ parts: [{ file_data: { file_uri: 'files/abc' } }] }] },
      { contents: text, generationConfig: { unknownKnob: 1 } },
      { contents: text, generationConfig: { candidateCount: 1 }, generation_config: { candidateCount: 8 } },
      { contents: text, generationConfig: { candidateCount: 1, candidate_count: 8 } },
      { contents: text, generationConfig: { imageConfig: { imageSize: '1K' }, image_config: { image_size: '4K' } } },
      { contents: text, stream: false },
    ];
    for (const body of bodies) expect((await call(socket, 'POST', IMAGE_PATH, body)).status).toBe(403);
    expect((await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5', input: 'x', tools: [] })).status).toBe(403);
    expect((await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5', input: 'x', is_stream: true })).status).toBe(403);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(['field', 'field', 'field', 'field', 'field', 'field', 'field', 'field', 'field', 'field', 'field', 'streaming', 'field', 'field']);
    expect(upstream.received).toEqual([]);
  });

  test('a normal image, music and text body still passes', async () => {
    const { socket, upstream } = await rig();
    const image = { contents: [{ role: 'user', parts: [{ text: 'a lighthouse' }] }], generationConfig: { candidateCount: 1, maxOutputTokens: 2048, responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9', imageSize: '2K' } } };
    expect((await call(socket, 'POST', IMAGE_PATH, image)).status).toBe(200);
    expect((await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5', input: 'a calm tune', generation_config: { seed: 3, max_output_tokens: 1024 } })).status).toBe(200);
    expect((await call(socket, 'POST', '/v1beta/models/gemini-3.5-flash-lite:generateContent', { contents: [{ parts: [{ text: 'adapt this prompt' }] }], systemInstruction: { parts: [{ text: 'be brief' }] }, generationConfig: { temperature: 0.2, maxOutputTokens: 256 } })).status).toBe(200);
    expect(upstream.received).toHaveLength(3);
  });

  test('an interaction naming an agent, a generate body naming another model and dot ids are refused', async () => {
    const { socket, upstream, calls } = await rig();
    const answers = [
      await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5', agent: 'deep-research' }),
      await call(socket, 'POST', IMAGE_PATH, { model: 'veo-3.1-generate-preview' }),
      await call(socket, 'GET', '/v1beta/interactions/.'),
      await call(socket, 'GET', '/v1beta/interactions/..'),
      await call(socket, 'GET', '/v1beta/interactions/.abc'),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([403, 403, 403, 403, 403]);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(['agent', 'model', 'path', 'path', 'path']);
    expect(upstream.received).toEqual([]);
  });

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

  test('with $1.05 left a $1.06 image is refused and the upstream sees nothing', async () => {
    const { socket, upstream, ledger, calls } = await rig({ capUsd: 1.2 });
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
    const session = await rig({ dir, capUsd: 5, sessionCapUsd: 2.5, caller: 'session' });
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
    expect(session.ledger.spentBy('session')).toBeCloseTo(2 * IMAGE_USD);
    expect(session.ledger.spentBy('served')).toBeCloseTo(IMAGE_USD);
    expect(session.ledger.spentUsd()).toBeCloseTo(3 * IMAGE_USD);
  });
});

describe('token limits', () => {
  const TEXT_PATH = '/v1beta/models/gemini-3.5-flash-lite:generateContent';
  const text = (prompt = 'a lighthouse') => [{ parts: [{ text: prompt }] }];
  const pixel = (mimeType = 'image/png') => ({ inlineData: { mimeType, data: Buffer.alloc(64, 7).toString('base64') } });

  test('each price is its model\'s worst case under its limits', () => {
    const image = priceOf(IMAGE_MODEL);
    if (image === undefined) throw new Error('the image model is not in the table');
    const input = image.limits.maxTextBytes + image.limits.maxImageParts * IMAGE_PART_TOKENS;
    const output = image.limits.maxOutputTokens + image.limits.maxThinkingTokens;
    const byTokens = (input * image.rates.usdPerMillionInput + output * image.rates.usdPerMillionOutput) / 1_000_000;
    expect(byTokens).toBeCloseTo(1.055808, 6);
    expect(image.usdPerCall).toBe(IMAGE_USD);
    expect(worstCaseUsd(image.limits, image.rates)).toBe(IMAGE_USD);
    expect(priceOf('lyria-3.5')?.usdPerCall).toBe(1.06);
    expect(priceOf('lyria-3-clip-preview')?.usdPerCall).toBe(1.06);
    expect(priceOf('gemini-3.5-flash-lite')?.usdPerCall).toBe(0.05);
    for (const model of [IMAGE_MODEL, 'lyria-3.5', 'lyria-3-clip-preview', 'gemini-3.5-flash-lite']) {
      expect(priceOf(model)?.limits.maxRequestBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
  });

  test('a body without maxOutputTokens, or over the cap, is refused and never reaches upstream', async () => {
    const { socket, upstream, calls, ledger } = await rig();
    const bodies: Array<[string, unknown]> = [
      [IMAGE_PATH, { contents: text() }],
      [IMAGE_PATH, {}],
      [IMAGE_PATH, { contents: text(), generationConfig: { temperature: 1 } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { maxOutputTokens: 4097 } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { maxOutputTokens: 0 } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { maxOutputTokens: 100.5 } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { maxOutputTokens: '1024' } }],
      [TEXT_PATH, { contents: text(), generationConfig: { maxOutputTokens: 2049 } }],
      ['/v1beta/interactions', { model: 'lyria-3.5', input: 'a calm tune' }],
      ['/v1beta/interactions', { model: 'lyria-3.5', input: 'a calm tune', generation_config: { max_output_tokens: 8193 } }],
    ];
    for (const [path, body] of bodies) expect((await call(socket, 'POST', path, body)).status).toBe(403);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(bodies.map(() => 'output-tokens'));
    expect(upstream.received).toEqual([]);
    expect(ledger.spentUsd()).toBe(0);
  });

  test('a thinking setting over the model\'s limit is refused and never reaches upstream', async () => {
    const { socket, upstream, calls } = await rig();
    const bodies: Array<[string, unknown]> = [
      [IMAGE_PATH, { contents: text(), generationConfig: { ...OUTPUT, thinkingConfig: { thinkingBudget: 4097 } } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { ...OUTPUT, thinkingConfig: { thinkingBudget: -1 } } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { ...OUTPUT, thinkingConfig: { thinkingLevel: 'ultra' } } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { ...OUTPUT, thinkingLevel: 'low' } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { ...OUTPUT, thinkingConfig: { thinkingBudget: 10, extraThoughts: 9 } } }],
      [IMAGE_PATH, { contents: text(), generationConfig: { ...OUTPUT, thinkingConfig: 'high' } }],
      [TEXT_PATH, { contents: text(), generationConfig: { ...OUTPUT, thinking_config: { thinking_level: 'high' } } }],
      ['/v1beta/interactions', { model: 'lyria-3.5', input: 'a calm tune', generation_config: { ...MUSIC_OUTPUT, thinking_level: 'minimal' } }],
    ];
    for (const [path, body] of bodies) expect((await call(socket, 'POST', path, body)).status).toBe(403);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(bodies.map(() => 'thinking'));
    expect(upstream.received).toEqual([]);
  });

  test('a body over the model\'s input limits is refused and never reaches upstream', async () => {
    const { socket, upstream, calls } = await rig();
    const answers = [
      await call(socket, 'POST', IMAGE_PATH, { contents: text('x'.repeat(17 * 1024)), generationConfig: OUTPUT }),
      await call(socket, 'POST', IMAGE_PATH, { contents: [{ parts: [pixel(), pixel(), pixel(), pixel(), pixel(), { text: 'five references' }] }], generationConfig: OUTPUT }),
      await call(socket, 'POST', IMAGE_PATH, { contents: [{ parts: [pixel('audio/mpeg'), { text: 'a song' }] }], generationConfig: OUTPUT }),
      await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5', input: [{ type: 'audio', data: 'AAAA', mime_type: 'image/png' }], generation_config: MUSIC_OUTPUT }),
      await call(socket, 'POST', TEXT_PATH, { contents: [{ parts: [pixel(), { text: 'describe' }] }], generationConfig: OUTPUT }),
      await call(socket, 'POST', IMAGE_PATH, { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'A'.repeat(8 * 1024 * 1024) } }] }], generationConfig: OUTPUT }),
      await call(socket, 'POST', TEXT_PATH, { contents: text('x'.repeat(129 * 1024)), generationConfig: OUTPUT }),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([403, 403, 403, 403, 403, 413, 413]);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(['input', 'input', 'input', 'field', 'input', 'body-too-large', 'body-too-large']);
    expect(upstream.received).toEqual([]);
  });

  test('a body at every cap passes and reserves the worst-case price', async () => {
    const { socket, upstream, spend, ledger } = await rig();
    const body = {
      contents: [{ parts: [pixel(), pixel('image/jpeg'), pixel('image/webp'), pixel(), { text: 'y'.repeat(15 * 1024) }] }],
      generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 4096, thinkingLevel: 'high', includeThoughts: false }, imageConfig: { imageSize: '2K' } },
    };
    expect((await call(socket, 'POST', IMAGE_PATH, body)).status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    expect(JSON.parse(upstream.received[0]?.body ?? '')).toEqual(body);
    const reserve = readLedger(spend).find((line) => line.type === 'reserve');
    expect(reserve?.usd).toBe(IMAGE_USD);
    expect(ledger.spentUsd()).toBeCloseTo(IMAGE_USD);
    const textBody = { contents: text('z'.repeat(60 * 1024)), generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 2048 }, thinkingLevel: 'low' } };
    expect((await call(socket, 'POST', TEXT_PATH, textBody)).status).toBe(200);
    expect(ledger.spentUsd()).toBeCloseTo(IMAGE_USD + 0.05);
  });
});

describe('where image data may be', () => {
  const TEXT_PATH = '/v1beta/models/gemini-3.5-flash-lite:generateContent';
  const fakeImage = () => ({ inlineData: { mimeType: 'image/png', data: 'x'.repeat(2_000_000) } });
  const prompt = [{ parts: [{ text: 'a lighthouse' }] }];

  test('fake images in a schema, a response format or a function response are refused and never reach upstream', async () => {
    const { socket, upstream, calls, ledger } = await rig();
    const schema = { type: 'object', properties: { a: fakeImage(), b: fakeImage(), c: fakeImage(), d: fakeImage() } };
    const bodies: Array<[string, unknown]> = [
      [IMAGE_PATH, { contents: prompt, generationConfig: { ...OUTPUT, responseJsonSchema: schema } }],
      [IMAGE_PATH, { contents: prompt, generationConfig: { ...OUTPUT, responseSchema: { type: 'object' } } }],
      [TEXT_PATH, { contents: prompt, generationConfig: { ...OUTPUT, responseJsonSchema: { properties: { a: { inlineData: { mimeType: 'image/png', data: 'x'.repeat(30_000) } } } } } }],
      ['/v1beta/interactions', { model: 'lyria-3.5', input: 'a calm tune', response_format: { type: 'audio', ...fakeImage() }, generation_config: MUSIC_OUTPUT }],
      ['/v1beta/interactions', { model: 'lyria-3.5', input: 'a calm tune', response_format: { type: 'audio', mime_type: 'image/png', data: 'x'.repeat(2_000_000) }, generation_config: MUSIC_OUTPUT }],
      [IMAGE_PATH, { contents: [{ parts: [{ functionResponse: { name: 'f', response: { image: fakeImage() } } }] }], generationConfig: OUTPUT }],
      [IMAGE_PATH, { contents: [{ parts: [{ functionCall: { name: 'f', args: {} } }] }], generationConfig: OUTPUT }],
      [IMAGE_PATH, { contents: [{ parts: [{ text: 'a' }], extra: fakeImage() }], generationConfig: OUTPUT }],
      [IMAGE_PATH, { contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA', extra: 'x' } }] }], generationConfig: OUTPUT }],
      [IMAGE_PATH, { contents: prompt, generationConfig: OUTPUT, safetySettings: [fakeImage()] }],
      ['/v1beta/interactions', { model: 'lyria-3.5', input: [{ type: 'function_result', data: 'x' }], generation_config: MUSIC_OUTPUT }],
      ['/v1beta/interactions', { model: IMAGE_MODEL, input: 'a lighthouse', response_format: { type: 'image', image_size: '4K' }, generation_config: OUTPUT }],
    ];
    for (const [path, body] of bodies) expect((await call(socket, 'POST', path, body)).status).toBe(403);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(bodies.map(() => 'field'));
    expect(upstream.received).toEqual([]);
    expect(ledger.spentUsd()).toBe(0);
  });

  test('text in a text model schema counts as text', async () => {
    const { socket, upstream, calls } = await rig();
    const schema = { type: 'object', description: 'y'.repeat(70 * 1024) };
    expect((await call(socket, 'POST', TEXT_PATH, { contents: prompt, generationConfig: { ...OUTPUT, responseJsonSchema: schema } })).status).toBe(403);
    expect(readCalls(calls).map((line) => line.reason)).toEqual(['input']);
    expect(upstream.received).toEqual([]);
  });

  test('images where the API reads them pass: inline parts, system instruction parts and interaction image items', async () => {
    const { socket, upstream } = await rig();
    const pixel = { inlineData: { mimeType: 'image/png', data: 'AAAA' } };
    const generate = { contents: [{ role: 'user', parts: [pixel, { text: 'like this' }] }], systemInstruction: { parts: [pixel] }, generationConfig: OUTPUT };
    expect((await call(socket, 'POST', IMAGE_PATH, generate)).status).toBe(200);
    const interaction = { model: IMAGE_MODEL, input: [{ type: 'text', text: 'like this' }, { type: 'image', data: 'AAAA', mime_type: 'image/png' }], response_format: { type: 'image', aspect_ratio: '16:9', image_size: '2K' }, generation_config: { ...OUTPUT, thinking_level: 'high' } };
    expect((await call(socket, 'POST', '/v1beta/interactions', interaction)).status).toBe(200);
    expect((await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5', input: [{ type: 'image', data: 'AAAA', mime_type: 'image/jpeg' }, { type: 'text', text: 'a tune' }], response_format: { type: 'audio' }, generation_config: MUSIC_OUTPUT })).status).toBe(200);
    expect(upstream.received).toHaveLength(3);
  });
});

describe('what the upstream call carries', () => {
  test('the body goes up as application/json whatever type the app named', async () => {
    const { socket, upstream } = await rig();
    expect((await call(socket, 'POST', IMAGE_PATH, { contents: [{ parts: [{ text: 'a' }] }], generationConfig: OUTPUT }, 'text/plain; charset=x')).status).toBe(200);
    expect(upstream.received[0]?.headers['content-type']).toBe('application/json');
  });

  test('a call the transport refuses before sending settles its reservation and frees its slot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-provider-'));
    const { socket, upstream, ledger, spend, calls } = await rig({ dir, key: 'bad\nkey' });
    const answer = await image(socket).catch(() => null);
    expect(answer === null || answer.cut || answer.status === 0).toBe(true);
    expect(upstream.received).toEqual([]);
    expect(ledger.inFlight()).toBe(0);
    const settle = readLedger(spend).find((line) => line.type === 'settle');
    expect(settle?.type === 'settle' ? settle.outcome : null).toBe('upstream-error');
    expect(readCalls(calls).map((line) => [line.reason, line.chargedUsd])).toEqual([['upstream-error', IMAGE_USD]]);
  });
});

describe('the ledger', () => {
  test('a response cut off mid-stream keeps its reservation', async () => {
    const { socket, upstream, ledger, spend } = await rig();
    upstream.cutOff = true;
    const answer = await image(socket);
    expect(answer.cut).toBe(true);
    expect(ledger.spentUsd()).toBeCloseTo(IMAGE_USD);
    expect(ledger.inFlight()).toBe(0);
    const settle = readLedger(spend).find((line) => line.type === 'settle');
    expect(settle?.type === 'settle' ? [settle.usd, settle.outcome] : null).toEqual([IMAGE_USD, 'cut-off']);
  });

  test('after a restart an unsettled reservation still counts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-provider-'));
    const path = join(dir, 'spend.jsonl');
    const before = openProviderLedger({ path, capUsd: 1.5 });
    expect(typeof before.reserve('served', IMAGE_MODEL, IMAGE_USD)).toBe('object');
    const { socket, upstream, ledger } = await rig({ dir, capUsd: 1.5 });
    expect(ledger.spentUsd()).toBeCloseTo(IMAGE_USD);
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
    expect((await call(socket, 'POST', '/v1beta/interactions', { model: 'lyria-3.5', generation_config: MUSIC_OUTPUT })).status).toBe(503);
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
    expect(readCalls(calls).map((line) => [line.path, line.action, line.chargedUsd])).toEqual([[IMAGE_PATH, 'forwarded', IMAGE_USD], ['/v1beta/models', 'refused', 0]]);
  });
});
