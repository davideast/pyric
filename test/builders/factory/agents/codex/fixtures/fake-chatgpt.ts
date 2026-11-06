/**
 * A stand-in for the upstream, in plain HTTP on loopback, for the factory's
 * tests. It records what it received and answers with a streamed turn, or
 * with a 429 in the upstream's rate-limit shape once `limited` is set. No
 * test reaches the real upstream.
 */
import http from 'node:http';

export interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeChatgpt {
  port: number;
  received: Received[];
  /** Answer every request with a rate-limit 429 that resets at this Unix second. */
  limitedUntil: number | null;
  close(): Promise<void>;
}

const TURN = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r"}}\n\n',
];

export async function startFakeChatgpt(): Promise<FakeChatgpt> {
  const fake: FakeChatgpt = { port: 0, received: [], limitedUntil: null, close: async () => {} };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      fake.received.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      if (fake.limitedUntil !== null) {
        response.writeHead(429, { 'content-type': 'application/json', 'x-codex-primary-used-percent': '100', 'x-codex-primary-reset-at': String(fake.limitedUntil) });
        response.end(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'Rate limit reached', resets_at: fake.limitedUntil } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '42', 'x-codex-primary-reset-at': '1793790664' });
      for (const event of TURN) response.write(event);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake backend has no port');
  fake.port = address.port;
  fake.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fake;
}
