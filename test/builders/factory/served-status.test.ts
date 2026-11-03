// The served copy's status page and its address: the page names the served
// commit, the commits since the one served before it, and the failing
// gates, escaped; the relay answers /_factory/status on the served copy's
// own port and passes every other request, before and after it, through to
// Studio; and the port listens on loopback unless PYRIC_FACTORY_SERVE_HOST
// names one address, never a host name or a wildcard.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LastServed } from './last-served.ts';
import { relayPortToSocket } from './relay.ts';
import { allowedHosts, isLoopback, LOOPBACK, serveHost, ServeHostInvalid } from './serve-host.ts';
import { servedUrls } from './served.ts';
import { STATUS_PATH, statusPage } from './status-page.ts';
import { parseHead } from './status-route.ts';

const COMMIT = 'acf8f7a25106' + 'd'.repeat(28);
const PREVIOUS = '182e5f2aaaaa' + 'e'.repeat(28);

const record: LastServed = {
  commit: COMMIT,
  hour: 2,
  at: '2026-11-02T19:24:00.000Z',
  failing: ['tests', 'walks'],
  since: { commit: PREVIOUS, what: 'previous' },
  changes: ['fix the <b>playlist</b> title', 'add the playlist page'],
};

describe('statusPage', () => {
  test('names the served commit, the commits since the one served before it, and the failing gates', () => {
    const html = statusPage(COMMIT, record);
    expect(html).toContain('<p>Commit <code>acf8f7a25106</code>, checked in hour 2 at 2026-11-02T19:24:00.000Z</p>');
    expect(html).toContain('<h2>Failing gates</h2>\n<ul>\n<li>tests</li>\n<li>walks</li>\n</ul>');
    expect(html).toContain('<h2>Changes since the previously served commit, <code>182e5f2aaaaa</code></h2>');
    expect(html).toContain('<li>fix the &lt;b&gt;playlist&lt;/b&gt; title</li>\n<li>add the playlist page</li>');
    expect(html).not.toContain('<b>');
  });

  test('says so when every gate passed, nothing changed, the commits could not be listed, or the record is for the start', () => {
    expect(statusPage(COMMIT, { ...record, failing: [] })).toContain('<p>None. Every gate passed.</p>');
    expect(statusPage(COMMIT, { ...record, changes: [] })).toContain('<p>No new commits.</p>');
    const { changes: _unused, ...unlisted } = record;
    expect(statusPage(COMMIT, unlisted)).toContain('<p>The commits could not be listed.</p>');
    expect(statusPage(COMMIT, { ...record, since: { commit: PREVIOUS, what: 'start' } })).toContain('Changes since the run\'s start commit');
  });

  test('never shows a record for another commit as this one\'s', () => {
    for (const other of [undefined, { ...record, commit: PREVIOUS }]) {
      const html = statusPage(COMMIT, other);
      expect(html).toContain('<code>acf8f7a25106</code>');
      expect(html).toContain('No check has recorded this commit yet.');
      expect(html).not.toContain('Failing gates');
    }
  });
});

describe('parseHead', () => {
  test('reads the path without its query, the body length, and what it can\'t follow', () => {
    expect(parseHead('GET /_factory/status?x=1 HTTP/1.1\r\nHost: a')).toEqual({ method: 'GET', path: '/_factory/status', contentLength: 0, passThrough: false });
    expect(parseHead('POST /api HTTP/1.1\r\nContent-Length: 12')).toMatchObject({ contentLength: 12, passThrough: false });
    expect(parseHead('GET /_next/webpack-hmr HTTP/1.1\r\nUpgrade: websocket').passThrough).toBe(true);
    expect(parseHead('POST /api HTTP/1.1\r\nTransfer-Encoding: chunked').passThrough).toBe(true);
    expect(parseHead('POST /api HTTP/1.1\r\nContent-Length: -1').passThrough).toBe(true);
  });
});

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Studio's stand-in on a Unix socket: answers each request with its method and path, keeping the connection open. */
async function fakeStudio(): Promise<string> {
  const socket = join(mkdtempSync(join(tmpdir(), 'factory-status-')), 'app.sock');
  const server = createServer((client) => {
    let pending = '';
    client.on('data', (chunk) => {
      pending += chunk.toString('latin1');
      for (let end = pending.indexOf('\r\n\r\n'); end !== -1; end = pending.indexOf('\r\n\r\n')) {
        const head = parseHead(pending.slice(0, end));
        const rest = pending.slice(end + 4);
        const body = rest.slice(0, head.contentLength);
        pending = rest.slice(head.contentLength);
        const text = `studio ${head.method} ${head.path} ${body}`;
        client.write(`HTTP/1.1 200 OK\r\nContent-Length: ${text.length}\r\n\r\n${text}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  servers.push(server);
  return socket;
}

async function relayWithStatus(socket: string): Promise<number> {
  const server = await relayPortToSocket(0, socket, LOOPBACK, { path: STATUS_PATH, body: () => statusPage(COMMIT, record) });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the relay has no port');
  return address.port;
}

/** Sends `requests` on one connection, one after another's response, and returns what came back. */
async function onOneConnection(port: number, requests: string[]): Promise<string> {
  const client = connect(port, LOOPBACK);
  let received = '';
  client.on('data', (chunk) => { received += chunk.toString('utf8'); });
  for (const request of requests) {
    const before = received.length;
    client.write(request);
    for (let tries = 0; tries < 200 && received.length === before; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  client.destroy();
  return received;
}

describe('the status route on the served port', () => {
  test('answers /_factory/status itself and passes other requests through to Studio', async () => {
    const port = await relayWithStatus(await fakeStudio());
    const page = await fetch(`http://${LOOPBACK}:${port}${STATUS_PATH}`);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('<li>walks</li>');
    expect(await (await fetch(`http://${LOOPBACK}:${port}/playlists?id=1`)).text()).toBe('studio GET /playlists ');
  });

  test('finds the status request after a request with a body on a kept-alive connection', async () => {
    const port = await relayWithStatus(await fakeStudio());
    const received = await onOneConnection(port, [
      'POST /api/save HTTP/1.1\r\nHost: a\r\nContent-Length: 13\r\n\r\nGET /_factory',
      'GET /settings HTTP/1.1\r\nHost: a\r\n\r\n',
      `GET ${STATUS_PATH} HTTP/1.1\r\nHost: a\r\n\r\n`,
    ]);
    expect(received).toContain('studio POST /api/save GET /_factory');
    expect(received).toContain('studio GET /settings ');
    expect(received).toContain('Connection: close');
    expect(received).toContain('<h1>Served build</h1>');
  });

  test('an upgraded connection is piped as it is', async () => {
    const port = await relayWithStatus(await fakeStudio());
    const received = await onOneConnection(port, [
      'GET /_next/webpack-hmr HTTP/1.1\r\nHost: a\r\nUpgrade: websocket\r\n\r\n',
      `GET ${STATUS_PATH} HTTP/1.1\r\nHost: a\r\n\r\n`,
    ]);
    expect(received).toContain(`studio GET ${STATUS_PATH} `);
    expect(received).not.toContain('Served build');
  });
});

describe('serveHost', () => {
  test('is loopback unless PYRIC_FACTORY_SERVE_HOST names one address', () => {
    expect(serveHost({})).toBe(LOOPBACK);
    expect(serveHost({ PYRIC_FACTORY_SERVE_HOST: '' })).toBe(LOOPBACK);
    expect(serveHost({ PYRIC_FACTORY_SERVE_HOST: '192.0.2.10' })).toBe('192.0.2.10');
    expect(serveHost({ PYRIC_FACTORY_SERVE_HOST: '2001:db8::10' })).toBe('2001:db8::10');
  });

  test('refuses a host name and a wildcard address', () => {
    for (const bad of ['box.example.net', 'localhost', '0.0.0.0', '::', '0:0::0', '192.0.2.10:4120']) {
      expect(() => serveHost({ PYRIC_FACTORY_SERVE_HOST: bad })).toThrow(ServeHostInvalid);
    }
  });

  test('the served copy listens on the address given, and the reported URLs use it', async () => {
    const socket = await fakeStudio();
    const server = await relayPortToSocket(0, socket, '127.0.0.2');
    servers.push(server);
    const address = server.address();
    expect(address !== null && typeof address === 'object' && address.address).toBe('127.0.0.2');
    expect(servedUrls(4120, '192.0.2.10')).toMatchObject({ localUrl: 'http://192.0.2.10:4120/', statusUrl: 'http://192.0.2.10:4120/_factory/status' });
    expect(servedUrls(4120, '2001:db8::10').localUrl).toBe('http://[2001:db8::10]:4120/');
  });

  test('Next and Pyric accept the bound address as a host, past loopback', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('192.0.2.10')).toBe(false);
    expect(allowedHosts(undefined, LOOPBACK)).toBeUndefined();
    expect(allowedHosts('box.example.net', LOOPBACK)).toBe('box.example.net');
    expect(allowedHosts('box.example.net', '192.0.2.10')).toBe('box.example.net,192.0.2.10');
    expect(allowedHosts(undefined, '192.0.2.10')).toBe('192.0.2.10');
  });
});
