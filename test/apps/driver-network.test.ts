/**
 * The driver's browser reaches only 127.0.0.1 and localhost (#1606). A page
 * WebSocket and a service-worker fetch to another host are blocked and
 * logged, while a local WebSocket and a local service worker still work.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import type { Browser, Page } from '@playwright/test';
import { AppRun, launchScenarioBrowser } from './driver.ts';

/** A reserved name that never resolves, under a production-looking parent. */
const BLOCKED_HOST = 'blocked.firebaseio.invalid';
/** How a local socket closes: the page closes it, and the host ends the connection without a close frame. */
const LOCAL_CLOSE = 'close 1006';
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Opens a WebSocket and resolves with what it saw: open, its first message, error, and close with its code. */
const OPEN_SOCKET = `
const openSocket = (url) => new Promise((resolve) => {
  const events = [];
  const socket = new WebSocket(url);
  socket.onopen = () => events.push('open');
  socket.onmessage = (event) => { events.push('message ' + event.data); socket.close(); };
  socket.onerror = () => events.push('error');
  socket.onclose = (event) => { events.push('close ' + event.code); resolve(events); };
  setTimeout(() => resolve([...events, 'no close after 5s']), 5000);
});`;

const PAGE = `<!doctype html><title>driver network</title>
<script>
${OPEN_SOCKET}
window.openSocket = openSocket;
window.openSocketInWorker = (url) => new Promise((resolve) => {
  const worker = new Worker('/socket-worker.js');
  worker.onmessage = (event) => resolve(event.data);
  worker.postMessage(url);
});
window.fetchFromServiceWorker = async (url) => {
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const channel = new MessageChannel();
  const reply = new Promise((resolve) => { channel.port1.onmessage = (event) => resolve(event.data); });
  registration.active.postMessage(url, [channel.port2]);
  return reply;
};
</script>`;

/** A dedicated worker: no Playwright route sees the WebSockets it opens. */
const SOCKET_WORKER = `${OPEN_SOCKET}
onmessage = (event) => openSocket(event.data).then((events) => postMessage(events));`;

const SERVICE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  const reply = fetch(event.data, { mode: 'no-cors' })
    .then(() => 'reached', (error) => 'failed: ' + error.message)
    .then((outcome) => event.ports[0].postMessage(outcome));
  event.waitUntil(reply);
});`;

/** One unmasked text frame, for a payload under 126 bytes. */
function textFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function httpResponse(type: string, body: string): string {
  return `HTTP/1.1 200 OK\r\ncontent-type: ${type}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
}

/** Accepts the handshake, sends one "hello" frame, and ends the connection at the page's close frame. */
function acceptWebSocket(socket: Socket, key: string): void {
  const accept = createHash('sha1').update(`${key}${HANDSHAKE_GUID}`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.write(textFrame('hello'));
  socket.once('data', () => socket.end());
}

/** One request on a raw connection: the page, one of its workers, or a WebSocket. */
function answer(socket: Socket, head: string): void {
  const key = /^sec-websocket-key: *(\S+)/im.exec(head)?.[1];
  if (key) return acceptWebSocket(socket, key);
  if (head.startsWith('GET /sw.js ')) return void socket.end(httpResponse('text/javascript', SERVICE_WORKER));
  if (head.startsWith('GET /socket-worker.js ')) return void socket.end(httpResponse('text/javascript', SOCKET_WORKER));
  socket.end(httpResponse('text/html', PAGE));
}

/** A local host over node:net on `address`, so the WebSocket handshake does not depend on the runtime's HTTP upgrade. */
function localHost(address: string): Promise<Server> {
  const server = createServer((socket) => {
    let head = '';
    socket.on('error', () => {});
    const readHead = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.off('data', readHead);
      answer(socket, head);
    };
    socket.on('data', readHead);
  });
  return new Promise((resolve) => server.listen(0, address, () => resolve(server)));
}

let server: Server;
/** The same host on ::1, so a test can reach it as [::1]. */
let server6: Server;
let origin: string;
const portOf = (listening: Server) => (listening.address() as AddressInfo).port;
let browser: Promise<Browser> | undefined;
// The runner's own launch, so its resolver rules are under test too.
const launch = () => (browser ??= launchScenarioBrowser());

beforeAll(async () => {
  server = await localHost('127.0.0.1');
  server6 = await localHost('::1');
  origin = `127.0.0.1:${portOf(server)}`;
});

afterAll(async () => {
  if (browser) await (await browser).close();
  for (const listening of [server, server6]) await new Promise((resolve) => listening.close(resolve));
});

async function openedRun(): Promise<{ run: AppRun; page: Page }> {
  const run = new AppRun('driver-network', '.', '.', launch);
  const page = await run.page(`http://${origin}/`);
  return { run, page };
}

/** The helpers PAGE defines on window. */
interface PageHelpers {
  openSocket(url: string): Promise<string[]>;
  openSocketInWorker(url: string): Promise<string[]>;
  fetchFromServiceWorker(url: string): Promise<string>;
}

/** Calls one of PAGE's helpers in the page; what it resolves with is checked by the caller. */
function inPage(page: Page, helper: keyof PageHelpers, url: string): Promise<unknown> {
  const call = ({ name, arg }: { name: keyof PageHelpers; arg: string }): Promise<unknown> => (window as unknown as PageHelpers)[name](arg);
  return page.evaluate(call, { name: helper, arg: url });
}

async function withPage(check: (run: AppRun, page: Page) => Promise<void>): Promise<void> {
  const { run, page } = await openedRun();
  try {
    await check(run, page);
  } finally {
    await run.close();
  }
}

const blockedLines = (run: AppRun) => run.browserLog.filter((line) => line.startsWith('[blocked'));

describe('the browser reaches only local hosts (#1606)', () => {
  test('a page WebSocket to another host never opens, and the block is logged', () => withPage(async (run, page) => {
    const url = `wss://${BLOCKED_HOST}/.ws?ns=demo-app`;
    // 1008 is the driver's close: a socket it let through would open, or fail to resolve with 1006.
    expect(await inPage(page, 'openSocket', url)).toEqual(['close 1008']);
    expect(run.browserLog).toContain(`[blocked external WebSocket] ${url}`);
  }), 30_000);

  test('a host that only starts with a local name is another host', () => withPage(async (run, page) => {
    const url = 'ws://localhost.blocked.invalid/';
    expect(await inPage(page, 'openSocket', url)).toEqual(['close 1008']);
    expect(run.browserLog).toContain(`[blocked external WebSocket] ${url}`);
  }), 30_000);

  test('a service-worker fetch to another host fails, and the block is logged', () => withPage(async (run, page) => {
    const url = `https://${BLOCKED_HOST}/from-service-worker`;
    expect(await inPage(page, 'fetchFromServiceWorker', url)).toStartWith('failed: ');
    expect(run.browserLog).toContain(`[blocked external request] GET ${url}`);
  }), 30_000);

  test('page WebSockets to 127.0.0.1, localhost and [::1] open and get their message', () => withPage(async (run, page) => {
    for (const url of [`ws://${origin}/`, `ws://localhost:${portOf(server)}/`, `ws://[::1]:${portOf(server6)}/`]) {
      expect({ url, events: await inPage(page, 'openSocket', url) }).toEqual({ url, events: ['open', 'message hello', LOCAL_CLOSE] });
    }
    expect(blockedLines(run)).toEqual([]);
  }), 30_000);

  // No route sees a worker's WebSocket, so the launch's resolver rules stop it.
  // A *.localhost name resolves to loopback without them, so this reaches
  // nothing outside the machine either way.
  test('a worker WebSocket cannot resolve a name the driver does not allow', () => withPage(async (_run, page) => {
    const port = portOf(server);
    expect(await inPage(page, 'openSocketInWorker', `ws://127.0.0.1:${port}/`)).toEqual(['open', 'message hello', LOCAL_CLOSE]);
    expect(await inPage(page, 'openSocketInWorker', `ws://pyric-check.localhost:${port}/`)).toEqual(['error', 'close 1006']);
  }), 30_000);
});
