/**
 * A stand-in upstream for the made-up agent (`fake-agent.ts`), in plain HTTP
 * on loopback. It records what it received and answers 200, or a 429 that
 * names its reset once `limitedUntil` is set. No test reaches a real
 * upstream.
 */
import http from 'node:http';

export interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface FakeUpstream {
  port: number;
  received: Received[];
  /** Answer every request with a 429 that resets at this Unix second. */
  limitedUntil: number | null;
  close(): Promise<void>;
}

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const fake: FakeUpstream = { port: 0, received: [], limitedUntil: null, close: async () => {} };
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      fake.received.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      const isLimited = fake.limitedUntil !== null;
      response.writeHead(isLimited ? 429 : 200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(isLimited ? { resets_at: fake.limitedUntil } : { output: 'ok' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the fake upstream has no port');
  fake.port = address.port;
  fake.close = () => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fake;
}
