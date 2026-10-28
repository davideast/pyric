import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pinnedFetch } from './ollama-pinned-fetch';
import { createOllamaProvider } from './ollama-page';
import type { HostResolver } from './ollama-ssrf';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('pinnedFetch', () => {
  test('connects to the pinned address and keeps the hostname in the Host header', async () => {
    let seenHost: string | undefined;
    const port = await listen((req, res) => {
      seenHost = req.headers.host;
      res.setHeader('content-type', 'text/plain');
      res.end('pinned');
    });
    // The name does not resolve anywhere; only the pinned address can answer.
    const res = await pinnedFetch(`http://pinned.invalid:${port}/v1/x`, { method: 'GET' }, '127.0.0.1');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pinned');
    expect(seenHost).toBe(`pinned.invalid:${port}`);
  });

  test('does not follow a redirect', async () => {
    const port = await listen((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://169.254.169.254/');
      res.end();
    });
    await expect(
      pinnedFetch(`http://pinned.invalid:${port}/`, { method: 'GET' }, '127.0.0.1'),
    ).rejects.toThrow(/redirect/);
  });

  test('sends the request body and streams the response', async () => {
    const port = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => res.end(`echo:${Buffer.concat(chunks).toString()}`));
    });
    const res = await pinnedFetch(
      `http://pinned.invalid:${port}/`,
      { method: 'POST', body: '{"a":1}' },
      '127.0.0.1',
    );
    expect(await res.text()).toBe('echo:{"a":1}');
  });
});

describe('ollama provider server path under DNS rebinding', () => {
  test('connects to the vetted public address and never to the second answer', async () => {
    // First answer is public, every later answer is loopback.
    let calls = 0;
    const resolver: HostResolver = async () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
    const connectedTo: string[] = [];
    const provider = createOllamaProvider({
      isServer: true,
      resolver,
      fetchPinned: async (_url, _init, address) => {
        connectedTo.push(address);
        return new Response('data: [DONE]\n\n', { status: 200 });
      },
    });
    const events = [];
    for await (const e of provider({
      apiKey: 'http://rebind.example.com:11434',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    } as never)) {
      events.push(e);
    }
    expect(connectedTo).toEqual(['93.184.216.34']);
    expect(calls).toBe(1);
    expect(events.some((e) => e.kind === 'error')).toBe(false);
  });

  test('refuses a name whose answer is loopback before connecting', async () => {
    let connected = false;
    const provider = createOllamaProvider({
      isServer: true,
      resolver: async () => ['127.0.0.1'],
      fetchPinned: async () => {
        connected = true;
        return new Response('');
      },
    });
    const events = [];
    for await (const e of provider({
      apiKey: 'http://internal.example.com:11434',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    } as never)) {
      events.push(e);
    }
    expect(connected).toBe(false);
    expect(events[0]).toEqual({ kind: 'error', message: 'ollama: base URL not permitted' });
  });
});
