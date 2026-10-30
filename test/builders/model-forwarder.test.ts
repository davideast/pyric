// The model forwarder over real sockets, all on this machine: the "model API"
// is a plain-HTTP server on loopback the forwarder is pointed at through its
// test seam, and the credential is made up. Nothing here leaves loopback.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readChannelRecord, startBridge, type Listening } from './model-channel.ts';
import { startModelForwarder, type ForwarderOptions } from './model-forwarder.ts';
import { roundMeter, type RunMeter } from './model-meter.ts';
import { costOf } from './model-prices.ts';

const CREDENTIAL = 'made-up-credential-for-the-forwarder-test';
const PLACEHOLDER = 'placeholder-the-builder-holds';

const open: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const listening of open.splice(0).reverse()) await listening.close();
});

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const STREAM = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":1000,"output_tokens":1,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000}}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":400}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

async function fakeModelApi(): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += String(chunk); });
    request.on('end', () => {
      received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(STREAM);
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  open.push({ close: () => new Promise<void>((done) => server.close(() => done())) });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { port: address.port, received };
}

interface Setup {
  socketPath: string;
  record: string;
  received: Received[];
  meter: RunMeter;
}

async function forwarder(overrides: Partial<ForwarderOptions> = {}): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'builders-forwarder-'));
  const record = join(dir, 'channel.jsonl');
  writeFileSync(record, '');
  const api = await fakeModelApi();
  const meter = roundMeter(100).run(10);
  const socketPath = join(dir, 'f.sock');
  const listening: Listening = await startModelForwarder({
    socketPath, record, credential: CREDENTIAL, meter,
    upstream: { host: '127.0.0.1', port: api.port, tls: false },
    ...overrides,
  });
  open.push(listening);
  return { socketPath, record, received: api.received, meter: overrides.meter ?? meter };
}

/** Sends `bytes` over a fresh connection, then reads to close. `end` half-closes after sending. */
function exchange(connect: () => net.Socket, bytes: string, options: { end?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect();
    let received = '';
    socket.on('connect', () => {
      if (bytes !== '') socket.write(bytes);
      if (options.end === true) socket.end();
    });
    socket.on('data', (chunk) => { received += String(chunk); });
    socket.on('close', () => resolve(received));
    socket.on('error', () => resolve(received));
    socket.setTimeout(5_000, () => socket.destroy());
  });
}

const viaSocket = (path: string) => () => net.connect(path);

/**
 * The record once it has `count` lines. A client can see its connection
 * close before the forwarder has seen it close, and the forwarder writes a
 * closed connection's line when it does.
 */
async function recordLines(record: string, count: number): Promise<ReturnType<typeof readChannelRecord>> {
  const deadline = Date.now() + 2_000;
  while (readChannelRecord(record).length < count && Date.now() < deadline) await Bun.sleep(10);
  return readChannelRecord(record);
}

const messagesRequest = (body: string, extra = '') => [
  'POST /v1/messages?beta=true HTTP/1.1',
  'Host: 127.0.0.1:4000',
  `Authorization: Bearer ${PLACEHOLDER}`,
  'X-Api-Key: a-key-the-builder-made-up',
  'anthropic-version: 2023-06-01',
  'anthropic-beta: oauth-2025-04-20,claude-code-20250219',
  'content-type: application/json',
  `content-length: ${Buffer.byteLength(body)}`,
  ...(extra === '' ? [] : [extra]),
  '',
  body,
].join('\r\n');

describe('the model forwarder', () => {
  test('puts the harness credential on a Messages request, passes the betas on, streams the answer back and meters it', async () => {
    const setup = await forwarder();
    const body = JSON.stringify({ model: 'claude-haiku-5-5', stream: true, messages: [] });
    const answer = await exchange(viaSocket(setup.socketPath), messagesRequest(body));

    expect(answer).toStartWith('HTTP/1.1 200 ');
    expect(answer).toContain('event: message_stop');
    expect(setup.received).toHaveLength(1);
    const [sent] = setup.received;
    expect(sent).toMatchObject({ method: 'POST', url: '/v1/messages?beta=true', body });
    expect(sent?.headers).toMatchObject({
      authorization: `Bearer ${CREDENTIAL}`,
      host: 'api.anthropic.com',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      'accept-encoding': 'identity',
    });
    expect(sent?.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(sent?.headers)).not.toContain(PLACEHOLDER);

    const tokens = { input: 1000, output: 400, cacheCreation: 200, cacheRead: 3000 };
    const cost = costOf(tokens, 'claude-haiku-5-5');
    expect(readChannelRecord(setup.record)).toEqual([expect.objectContaining({
      layer: 'model-channel', host: 'api.anthropic.com', google: false, method: 'POST', path: '/v1/messages',
      action: 'forwarded', reason: null, status: 200, model: 'claude-haiku-5-5', tokens, costUsd: cost,
    })]);
    expect(setup.meter.spentUsd()).toBeCloseTo(cost, 12);
    expect(JSON.stringify(readChannelRecord(setup.record))).not.toContain(CREDENTIAL);
  });

  test('reads a large body whole before it sends it on', async () => {
    const setup = await forwarder();
    const body = JSON.stringify({ model: 'claude-haiku-5-5', messages: [{ role: 'user', content: 'x'.repeat(3_000_000) }] });
    expect(await exchange(viaSocket(setup.socketPath), messagesRequest(body))).toStartWith('HTTP/1.1 200 ');
    expect(setup.received[0]?.body).toBe(body);
  });

  test('decodes a chunked body and sends it on with its length', async () => {
    const setup = await forwarder();
    const body = '{"model":"claude-haiku-5-5"}';
    const chunked = [
      'POST /v1/messages HTTP/1.1', 'Host: x', 'Transfer-Encoding: chunked', '', `${(10).toString(16)}`, body.slice(0, 10), `${(body.length - 10).toString(16)}`, body.slice(10), '0', '', '',
    ].join('\r\n');
    expect(await exchange(viaSocket(setup.socketPath), chunked)).toStartWith('HTTP/1.1 200 ');
    expect(setup.received[0]).toMatchObject({ body, headers: { 'content-length': String(body.length) } });
  });

  const refusals: Array<[string, string, number, Record<string, unknown>]> = [
    ['claude’s model lookup', 'GET /v1/models?limit=1000 HTTP/1.1\r\nHost: x\r\n\r\n', 403, { reason: 'method', method: 'GET', path: '/v1/models' }],
    ['claude’s warm-up probe', 'HEAD /api/hello HTTP/1.1\r\nHost: x\r\n\r\n', 403, { reason: 'method', method: 'HEAD' }],
    ['another API path', 'POST /v1/files HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n', 403, { reason: 'path', path: '/v1/files' }],
    ['a Messages path with another query', 'POST /v1/messages?beta=true&x=1 HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n', 403, { reason: 'path' }],
    ['a CONNECT to the model API', 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n', 403, { reason: 'connect', host: 'api.anthropic.com' }],
    ['a CONNECT to a Google host', 'CONNECT oauth2.googleapis.com:443 HTTP/1.1\r\n\r\n', 403, { reason: 'connect', host: 'oauth2.googleapis.com', google: true }],
    ['an IPv6 CONNECT', 'CONNECT [2001:db8::1]:443 HTTP/1.1\r\n\r\n', 403, { reason: 'connect', host: '2001:db8::1' }],
    ['an absolute-URI GET', 'GET http://metadata.google.internal/computeMetadata/v1/ HTTP/1.1\r\nHost: metadata.google.internal\r\n\r\n', 403, { reason: 'absolute-uri', host: 'metadata.google.internal', metadata: true }],
    ['a malformed head', 'POST /v1/messages HTTP/1.1\r\nno colon here\r\n\r\n', 400, { reason: 'malformed', method: null, requestLine: 'POST /v1/messages HTTP/1.1' }],
    ['an unprintable request line', 'GET /\u0001 HTTP/1.1\r\n\r\n', 400, { reason: 'malformed', requestLine: 'GET /\\x01 HTTP/1.1' }],
    ['a body framed two ways', 'POST /v1/messages HTTP/1.1\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n', 400, { reason: 'framing' }],
    ['a head over the limit', `GET /${'a'.repeat(20_000)} HTTP/1.1\r\n\r\n`, 431, { reason: 'head-too-long' }],
  ];

  for (const [what, bytes, status, fields] of refusals) {
    test(`refuses and records ${what}, dialing nothing`, async () => {
      const setup = await forwarder();
      const answer = await exchange(viaSocket(setup.socketPath), bytes);
      expect(answer).toStartWith(`HTTP/1.1 ${status} `);
      expect(setup.received).toEqual([]);
      expect(readChannelRecord(setup.record)).toEqual([expect.objectContaining({ layer: 'model-channel', action: 'refused', status, costUsd: null, ...fields })]);
    });
  }

  test('records a client that closes before its head ends, naming the host it began to, and one that sends nothing', async () => {
    const setup = await forwarder();
    await exchange(viaSocket(setup.socketPath), 'GET http://oauth2.googleapis.com/ HT', { end: true });
    await recordLines(setup.record, 1);
    await exchange(viaSocket(setup.socketPath), '', { end: true });
    expect(await recordLines(setup.record, 2)).toEqual([
      expect.objectContaining({ action: 'refused', reason: 'closed-before-head', status: null, requestLine: 'GET http://oauth2.googleapis.com/ HT', host: 'oauth2.googleapis.com', google: true }),
      expect.objectContaining({ action: 'refused', reason: 'closed-before-head', status: null, requestLine: '', host: '(none)' }),
    ]);
  });

  test('times out a head that never ends', async () => {
    const setup = await forwarder({ headTimeoutMs: 200 });
    expect(await exchange(viaSocket(setup.socketPath), 'POST /v1/messages HTTP/1.1\r\nHost: x\r\n')).toStartWith('HTTP/1.1 408 ');
    expect(readChannelRecord(setup.record)).toEqual([expect.objectContaining({ reason: 'head-timeout', status: 408 })]);
  });

  test('refuses every request of a builder with no model, since it holds no credential', async () => {
    const setup = await forwarder({ credential: undefined });
    expect(await exchange(viaSocket(setup.socketPath), messagesRequest('{}'))).toStartWith('HTTP/1.1 403 ');
    expect(setup.received).toEqual([]);
    expect(readChannelRecord(setup.record)).toEqual([expect.objectContaining({ reason: 'no-credential' })]);
  });

  test('refuses once the run has spent its cap, and every run once the round has spent its total', async () => {
    const round = roundMeter(1);
    const spent = round.run(0.5);
    spent.charge().set(0.5);
    const setup = await forwarder({ meter: spent });
    expect(await exchange(viaSocket(setup.socketPath), messagesRequest('{}'))).toContain('run-cap');

    round.run(0.6).charge().set(0.5);
    const other = await forwarder({ meter: round.run(0.5) });
    expect(await exchange(viaSocket(other.socketPath), messagesRequest('{}'))).toContain('round-cap');
    expect([...setup.received, ...other.received]).toEqual([]);
    expect(readChannelRecord(other.record)).toEqual([expect.objectContaining({ reason: 'round-cap', status: 403 })]);
  });
});

describe('the bridge', () => {
  test('carries a request from loopback to the forwarder’s socket', async () => {
    const setup = await forwarder();
    const bridge = await startBridge(setup.socketPath);
    open.push(bridge);
    const answer = await exchange(() => net.connect(bridge.port, '127.0.0.1'), 'GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    expect(answer).toStartWith('HTTP/1.1 403 ');
    expect(readChannelRecord(setup.record)).toEqual([expect.objectContaining({ reason: 'method', host: '127.0.0.1' })]);
  });
});
