// The model forwarder over real sockets, all on this machine: the "model API"
// is a plain-HTTP server on loopback the forwarder is pointed at through its
// test seam, and the credential is made up. Nothing here leaves loopback.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMessageBody } from './message-body.ts';
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

const STREAM_START = [
  'event: message_start',
  'data: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":1000,"output_tokens":1,"cache_creation_input_tokens":200,"cache_read_input_tokens":3000}}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  '',
].join('\n');

const STREAM_END = [
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":400}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const STREAM_TOKENS = { input: 1000, output: 400, cacheCreation: 200, cacheRead: 3000 };

type Answer = (request: http.IncomingMessage, response: http.ServerResponse) => void;

const streamed: Answer = (_request, response) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(STREAM_START + STREAM_END);
};

async function fakeModelApi(answer: Answer): Promise<{ port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => { body += String(chunk); });
    request.on('end', () => {
      received.push({ method: request.method ?? '', url: request.url ?? '', headers: request.headers, body });
      answer(request, response);
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  open.push({ close: () => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()); }) });
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

async function forwarder(overrides: Partial<ForwarderOptions> = {}, answer: Answer = streamed): Promise<Setup> {
  const dir = mkdtempSync(join(tmpdir(), 'builders-forwarder-'));
  const record = join(dir, 'channel.jsonl');
  writeFileSync(record, '');
  const api = await fakeModelApi(answer);
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
  const deadline = Date.now() + 5_000;
  while (readChannelRecord(record).length < count && Date.now() < deadline) await Bun.sleep(10);
  return readChannelRecord(record);
}

const messagesRequest = (body: string, extra: string[] = [], path = '/v1/messages?beta=true') => [
  `POST ${path} HTTP/1.1`,
  'Host: 127.0.0.1:4000',
  `Authorization: Bearer ${PLACEHOLDER}`,
  'X-Api-Key: a-key-the-builder-made-up',
  'anthropic-version: 2023-06-01',
  'anthropic-beta: oauth-2025-04-20,claude-code-20250219',
  'content-type: application/json',
  `content-length: ${Buffer.byteLength(body)}`,
  ...extra,
  '',
  body,
].join('\r\n');

const haikuBody = (maxTokens = 1_000) => JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: maxTokens, stream: true, messages: [] });
const reservationOf = (body: string, path = '/v1/messages') => {
  const check = checkMessageBody(path, Buffer.from(body));
  if (check.kind !== 'allowed') throw new Error('refused');
  return check.reservedUsd;
};

describe('the model forwarder', () => {
  test('puts the harness credential on a Messages request, passes the allowed headers on, streams the answer back and meters it', async () => {
    const setup = await forwarder();
    const body = haikuBody();
    const extra = ['accept: application/json', 'user-agent: claude-cli/test', 'x-stainless-os: Linux', 'x-claude-code-session-id: s-1', 'cookie: c=secret-cookie', 'x-builder-made-this-up: 1'];
    const answer = await exchange(viaSocket(setup.socketPath), messagesRequest(body, extra));

    expect(answer).toStartWith('HTTP/1.1 200 ');
    expect(answer).toContain('event: message_stop');
    expect(setup.received).toHaveLength(1);
    const [sent] = setup.received;
    expect(sent).toMatchObject({ method: 'POST', url: '/v1/messages?beta=true', body });
    expect(sent?.headers).toEqual({
      authorization: `Bearer ${CREDENTIAL}`,
      host: 'api.anthropic.com',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219',
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'accept-encoding': 'identity',
      'x-stainless-os': 'Linux',
      'x-claude-code-session-id': 's-1',
      accept: 'application/json',
      'user-agent': 'claude-cli/test',
    });
    expect(JSON.stringify(sent?.headers)).not.toContain(PLACEHOLDER);

    const cost = costOf(STREAM_TOKENS, 'claude-haiku-5-5');
    const record = readChannelRecord(setup.record);
    expect(record).toEqual([expect.objectContaining({
      layer: 'model-channel', host: 'api.anthropic.com', google: false, method: 'POST', path: '/v1/messages',
      action: 'forwarded', reason: null, status: 200, model: 'claude-haiku-5-5', tokens: STREAM_TOKENS, costUsd: cost,
      reservedUsd: reservationOf(body), chargedUsd: cost, droppedHeaders: ['x-api-key', 'cookie', 'x-builder-made-this-up'],
    })]);
    expect(setup.meter.spentUsd()).toBeCloseTo(cost, 12);
    expect(setup.meter.inFlight()).toBe(0);
    expect(JSON.stringify(record)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(record)).not.toContain('secret-cookie');
  });

  test('reads a large body whole before it sends it on', async () => {
    const setup = await forwarder();
    const body = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 10, messages: [{ role: 'user', content: 'x'.repeat(3_000_000) }] });
    expect(await exchange(viaSocket(setup.socketPath), messagesRequest(body))).toStartWith('HTTP/1.1 200 ');
    expect(setup.received[0]?.body).toBe(body);
  });

  test('decodes a chunked body and sends it on with its length', async () => {
    const setup = await forwarder();
    const body = '{"model":"claude-haiku-5-5","max_tokens":5}';
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
    ['a body that is not JSON', messagesRequest('not json'), 400, { reason: 'body-not-json' }],
    ['a request with no max_tokens', messagesRequest('{"model":"claude-haiku-5-5","messages":[]}'), 400, { reason: 'max-tokens' }],
    ['a request naming MCP servers', messagesRequest('{"max_tokens":1,"mcp_servers":[{"type":"url","url":"https://example.com","name":"x"}]}'), 400, { reason: 'field', refusedNames: ['mcp_servers'] }],
    ['a request with a repeated key', messagesRequest('{"max_tokens":1,"max_tokens":64000}'), 400, { reason: 'duplicate-key', refusedNames: ['max_tokens'] }],
    ['an image from a URL', messagesRequest('{"max_tokens":1,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"url","url":"https://firebasestorage.googleapis.com/x.png"}}]}]}'), 403, { reason: 'source', refusedNames: ['messages[0].content[0].source.type=url'] }],
    ['a request with a server tool', messagesRequest('{"max_tokens":1,"tools":[{"type":"web_fetch_20260209","name":"web_fetch"}]}'), 400, { reason: 'server-tool', refusedNames: ['web_fetch_20260209'] }],
  ];

  for (const [what, bytes, status, fields] of refusals) {
    test(`refuses and records ${what}, dialing nothing`, async () => {
      const setup = await forwarder();
      const answer = await exchange(viaSocket(setup.socketPath), bytes);
      expect(answer).toStartWith(`HTTP/1.1 ${status} `);
      expect(setup.received).toEqual([]);
      expect(readChannelRecord(setup.record)).toEqual([expect.objectContaining({ layer: 'model-channel', action: 'refused', status, costUsd: null, chargedUsd: null, ...fields })]);
      expect(setup.meter.spentUsd()).toBe(0);
    });
  }

  test('names a refused server tool after Input tag, so claude can retry without its advisor', async () => {
    const setup = await forwarder();
    const answer = await exchange(viaSocket(setup.socketPath), messagesRequest('{"max_tokens":1,"tools":[{"type":"advisor_20260301","name":"advisor"}]}'));
    expect(answer).toContain("Input tag 'advisor_20260301'");
  });

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
    expect(await exchange(viaSocket(setup.socketPath), messagesRequest(haikuBody()))).toStartWith('HTTP/1.1 403 ');
    expect(setup.received).toEqual([]);
    expect(readChannelRecord(setup.record)).toEqual([expect.objectContaining({ reason: 'no-credential' })]);
  });

  test('refuses a request whose worst case doesn’t fit what is left of the run’s cap or the round’s total', async () => {
    const body = haikuBody(64_000);
    const reserved = reservationOf(body);
    const round = roundMeter(reserved * 1.5);
    const setup = await forwarder({ meter: round.run(reserved * 0.9) });
    expect(await exchange(viaSocket(setup.socketPath), messagesRequest(body))).toStartWith('HTTP/1.1 403 ');

    round.run(10).reserve(reserved);
    const other = await forwarder({ meter: round.run(10) });
    expect(await exchange(viaSocket(other.socketPath), messagesRequest(body))).toContain('round-cap');
    expect([...setup.received, ...other.received]).toEqual([]);
    expect(readChannelRecord(setup.record)).toEqual([expect.objectContaining({ reason: 'run-cap', status: 403 })]);
    expect(readChannelRecord(other.record)).toEqual([expect.objectContaining({ reason: 'round-cap', status: 403 })]);
  });
});

/** A model API that holds every response until `release` is called. */
function heldApi() {
  const held: Array<() => void> = [];
  let released = false;
  const answer: Answer = (request, response) => {
    const send = () => streamed(request, response);
    if (released) send();
    else held.push(send);
  };
  const release = () => {
    released = true;
    for (const send of held.splice(0)) send();
  };
  return { answer, release, held };
}

describe('the meter under concurrency', () => {
  test('lets twenty requests sent at once spend no more than a $0.01 run and round cap', async () => {
    const api = heldApi();
    const meter = roundMeter(0.01).run(0.01);
    const setup = await forwarder({ meter }, api.answer);
    const body = haikuBody();
    const answers = Array.from({ length: 20 }, () => exchange(viaSocket(setup.socketPath), messagesRequest(body)));
    await recordLines(setup.record, 18);

    expect(setup.received.length).toBeLessThanOrEqual(2);
    expect(meter.spentUsd()).toBeLessThanOrEqual(0.01);
    api.release();
    const statuses = (await Promise.all(answers)).map((answer) => answer.slice(9, 12));
    const record = await recordLines(setup.record, 20);

    expect(statuses.filter((status) => status === '200')).toHaveLength(setup.received.length);
    expect(statuses.filter((status) => status !== '200').every((status) => status === '403' || status === '429')).toBe(true);
    const refusedReasons = new Set(record.filter((event) => event.action === 'refused').map((event) => event.reason));
    expect([...refusedReasons].every((reason) => reason === 'in-flight' || reason === 'run-cap')).toBe(true);
    expect(meter.spentUsd()).toBeLessThanOrEqual(0.01);
    expect(record.reduce((sum, event) => sum + (event.chargedUsd ?? 0), 0)).toBeCloseTo(meter.spentUsd(), 12);
  });

  test('counts a held request’s whole worst case, so a second one that would pass the round cap is refused while the first is open', async () => {
    const api = heldApi();
    const body = haikuBody();
    const round = roundMeter(reservationOf(body) * 1.5);
    const setup = await forwarder({ meter: round.run(10) }, api.answer);
    const first = exchange(viaSocket(setup.socketPath), messagesRequest(body));
    while (api.held.length < 1) await Bun.sleep(10);
    expect(await exchange(viaSocket(setup.socketPath), messagesRequest(body))).toContain('round-cap');
    api.release();
    expect(await first).toStartWith('HTTP/1.1 200 ');
    expect(round.spentUsd()).toBeCloseTo(costOf(STREAM_TOKENS, 'claude-haiku-5-5'), 12);
  });

  test('tells a request over the run’s two in flight to retry, with retry-after', async () => {
    const api = heldApi();
    const setup = await forwarder({}, api.answer);
    const first = [exchange(viaSocket(setup.socketPath), messagesRequest(haikuBody())), exchange(viaSocket(setup.socketPath), messagesRequest(haikuBody()))];
    while (api.held.length < 2) await Bun.sleep(10);
    const third = await exchange(viaSocket(setup.socketPath), messagesRequest(haikuBody()));
    expect(third).toStartWith('HTTP/1.1 429 ');
    expect(third.toLowerCase()).toContain('retry-after: 2');
    expect(third).toContain('rate_limit_error');
    api.release();
    await Promise.all(first);
    expect(setup.meter.inFlight()).toBe(0);
  });
});

describe('settling a request', () => {
  test('keeps the whole reservation for a stream cut off before it ends', async () => {
    const cutOff: Answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(STREAM_START, () => setTimeout(() => response.destroy(), 50));
    };
    const setup = await forwarder({}, cutOff);
    const body = haikuBody(64_000);
    await exchange(viaSocket(setup.socketPath), messagesRequest(body));
    const [event] = await recordLines(setup.record, 1);
    expect(event).toMatchObject({ action: 'forwarded', reason: 'upstream-error', reservedUsd: reservationOf(body), chargedUsd: reservationOf(body) });
    expect(setup.meter.spentUsd()).toBeCloseTo(reservationOf(body), 12);
  });

  test('aborts a request the model API never answers, frees its slot and keeps its reservation', async () => {
    const silent: Answer = () => undefined;
    const setup = await forwarder({ upstreamTimeoutMs: 300 }, silent);
    const body = haikuBody();
    const answer = await exchange(viaSocket(setup.socketPath), messagesRequest(body));
    expect(answer).toStartWith('HTTP/1.1 504 ');
    const [event] = await recordLines(setup.record, 1);
    expect(event).toMatchObject({ action: 'forwarded', reason: 'upstream-timeout', status: 504, chargedUsd: reservationOf(body) });
    expect(setup.meter.inFlight()).toBe(0);
    expect(setup.meter.spentUsd()).toBeCloseTo(reservationOf(body), 12);
  });

  test('aborts a stream that outlasts the limit after it began, keeping its reservation', async () => {
    const stalled: Answer = (_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(STREAM_START);
    };
    const setup = await forwarder({ upstreamTimeoutMs: 300 }, stalled);
    const body = haikuBody();
    expect(await exchange(viaSocket(setup.socketPath), messagesRequest(body))).toStartWith('HTTP/1.1 200 ');
    const [event] = await recordLines(setup.record, 1);
    expect(event).toMatchObject({ reason: 'upstream-timeout', status: 200, chargedUsd: reservationOf(body) });
    expect(setup.meter.inFlight()).toBe(0);
  });

  test('frees the slot of a client that hangs up mid-stream, keeping its reservation', async () => {
    const api = heldApi();
    const setup = await forwarder({}, api.answer);
    const body = haikuBody();
    const socket = net.connect(setup.socketPath);
    socket.on('error', () => undefined);
    socket.write(messagesRequest(body));
    while (api.held.length < 1) await Bun.sleep(10);
    expect(setup.meter.inFlight()).toBe(1);
    socket.destroy();
    const [event] = await recordLines(setup.record, 1);
    expect(event).toMatchObject({ reason: 'client-closed', chargedUsd: reservationOf(body) });
    expect(setup.meter.inFlight()).toBe(0);
  });

  test('frees every slot after error answers, so later requests still go', async () => {
    const failing: Answer = (_request, response) => {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"type":"error","error":{"type":"api_error","message":"x"}}');
    };
    const setup = await forwarder({}, failing);
    for (let sent = 0; sent < 4; sent += 1) expect(await exchange(viaSocket(setup.socketPath), messagesRequest(haikuBody()))).toStartWith('HTTP/1.1 500 ');
    expect(setup.received).toHaveLength(4);
    expect(setup.meter.inFlight()).toBe(0);
    expect(setup.meter.spentUsd()).toBe(0);
  });

  const noUsage: Array<[string, number, string, (body: string) => number]> = [
    ['a 200 answer with no usage costs its reservation', 200, '/v1/messages', (body) => reservationOf(body)],
    ['a token count with no usage costs nothing', 200, '/v1/messages/count_tokens', () => 0],
    ['an error answer with no usage costs nothing', 400, '/v1/messages', () => 0],
  ];

  for (const [what, status, path, expected] of noUsage) {
    test(what, async () => {
      const answer: Answer = (_request, response) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end('{"input_tokens":12}');
      };
      const setup = await forwarder({}, answer);
      const body = haikuBody();
      await exchange(viaSocket(setup.socketPath), messagesRequest(body, [], path));
      const [event] = await recordLines(setup.record, 1);
      expect(event).toMatchObject({ action: 'forwarded', status, costUsd: null, chargedUsd: expected(body) });
      expect(setup.meter.spentUsd()).toBe(expected(body));
    });
  }
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
