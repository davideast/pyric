import { describe, expect, test } from 'bun:test';
import { browserEvents, readNetLog, splitAddress, type BrowserConnect, type BrowserRequest, type NetLogEvent } from './recorder/chromium-netlog.ts';

// A small NetLog in the layout Chromium writes: the constants on the first
// line, `"events": [` on the second, then one event per line. The numbers are
// this fixture's own; the reader only ever goes through the constants.
const constants = {
  logEventTypes: { REQUEST_ALIVE: 10, URL_REQUEST_START_JOB: 11, TCP_CONNECT_ATTEMPT: 12, UDP_CONNECT: 13, HOST_RESOLVER_MANAGER_REQUEST: 14 },
  logSourceType: { URL_REQUEST: 1, SOCKET: 2, UDP_SOCKET: 3, TRANSPORT_CONNECT_JOB: 4 },
  logEventPhase: { PHASE_NONE: 0, PHASE_BEGIN: 1, PHASE_END: 2 },
  netError: { ERR_NAME_NOT_RESOLVED: -105, ERR_ABORTED: -3 },
};

const BEGIN = 1;
const END = 2;
const URL_REQUEST = 1;

function event(type: number, sourceType: number, id: number, phase: number, params?: Record<string, unknown>): NetLogEvent {
  return { type, phase, source: { id, type: sourceType }, ...(params ? { params } : {}) };
}

function alive(id: number, url: string): NetLogEvent {
  return event(10, URL_REQUEST, id, BEGIN, { url, priority: 'MEDIUM' });
}

function startJob(id: number, url: string, method = 'GET'): NetLogEvent {
  return event(11, URL_REQUEST, id, BEGIN, { url, method, initiator: 'http://127.0.0.1:5173' });
}

function endJob(id: number, netError?: number): NetLogEvent {
  return event(11, URL_REQUEST, id, END, netError === undefined ? undefined : { net_error: netError });
}

function endAlive(id: number, netError?: number): NetLogEvent {
  return event(10, URL_REQUEST, id, END, netError === undefined ? undefined : { net_error: netError });
}

function chromiumLayout(events: readonly NetLogEvent[], terminated = true): string {
  const lines = [`{"constants":${JSON.stringify(constants)},`, '"events": ['];
  lines.push(...events.map((entry) => `${JSON.stringify(entry)},`));
  if (terminated) lines.push(']', '}');
  return `${lines.join('\n')}\n`;
}

const PAGE_EVENTS: NetLogEvent[] = [
  alive(1, 'http://127.0.0.1:5173/'),
  startJob(1, 'http://127.0.0.1:5173/'),
  endJob(1),
  endAlive(1),
  alive(2, 'wss://demo-x-default-rtdb.firebaseio.com/.ws?v=5'),
  startJob(2, 'wss://demo-x-default-rtdb.firebaseio.com/.ws?v=5'),
  event(14, 4, 9, BEGIN, { host: 'https://~notfound' }),
  endJob(2, -105),
  endAlive(2, -105),
  event(12, 2, 20, BEGIN, { address: '127.0.0.1:5173' }),
  event(13, 3, 21, BEGIN, { address: '[2001:4860:4860::8888]:443' }),
];

function requests(text: string): BrowserRequest[] {
  return browserEvents(readNetLog(text)).filter((entry): entry is BrowserRequest => entry.kind === 'request');
}

function connects(text: string): BrowserConnect[] {
  return browserEvents(readNetLog(text)).filter((entry): entry is BrowserConnect => entry.kind === 'connect');
}

describe('browserEvents', () => {
  test('a completed local request has net error 0 and is not Google', () => {
    const [page] = requests(chromiumLayout(PAGE_EVENTS));
    expect(page).toMatchObject({ layer: 'browser', kind: 'request', url: 'http://127.0.0.1:5173/', method: 'GET', netError: 0, google: false });
    expect(page?.netErrorName).toBeUndefined();
  });

  test('a WebSocket handshake to the Realtime Database is a Google request that failed to resolve', () => {
    const socket = requests(chromiumLayout(PAGE_EVENTS)).find((entry) => entry.url.startsWith('wss:'));
    expect(socket).toMatchObject({
      host: 'demo-x-default-rtdb.firebaseio.com',
      google: true,
      service: 'Realtime Database',
      catalogGap: false,
      netError: -105,
      netErrorName: 'ERR_NAME_NOT_RESOLVED',
    });
  });

  test('host resolution events are left out: under the resolver rules they name ~notfound', () => {
    const urls = requests(chromiumLayout(PAGE_EVENTS)).map((entry) => entry.url);
    expect(urls).toEqual(['http://127.0.0.1:5173/', 'wss://demo-x-default-rtdb.firebaseio.com/.ws?v=5']);
  });

  test('TCP and UDP connects carry their address, split into host and port', () => {
    expect(connects(chromiumLayout(PAGE_EVENTS)).map(({ protocol, host, port, google }) => ({ protocol, host, port, google }))).toEqual([
      { protocol: 'tcp', host: '127.0.0.1', port: 5173, google: false },
      // Chromium's IPv6 reachability check, to Google Public DNS: a Google address, though no packet is sent.
      { protocol: 'udp', host: '2001:4860:4860::8888', port: 443, google: true },
    ]);
  });

  test('each leg of a redirected request is its own event, so a redirect to a Google host is seen', () => {
    const text = chromiumLayout([
      alive(3, 'http://127.0.0.1:5173/go'),
      startJob(3, 'http://127.0.0.1:5173/go'),
      endJob(3),
      startJob(3, 'https://firebasestorage.googleapis.com/v0/b/x/o'),
      endJob(3, -105),
      endAlive(3, -105),
    ]);
    expect(requests(text).map(({ url, netError, google }) => ({ url, netError, google }))).toEqual([
      { url: 'http://127.0.0.1:5173/go', netError: 0, google: false },
      { url: 'https://firebasestorage.googleapis.com/v0/b/x/o', netError: -105, google: true },
    ]);
  });

  test('a request refused before its job started is still recorded, from REQUEST_ALIVE', () => {
    const [refused] = requests(chromiumLayout([alive(4, 'https://www.gstatic.com/a.png'), endAlive(4, -3)]));
    expect(refused).toMatchObject({ url: 'https://www.gstatic.com/a.png', netError: -3, netErrorName: 'ERR_ABORTED', catalogGap: true });
  });

  test('a request still open when the log ends has no net error', () => {
    const [open] = requests(chromiumLayout([alive(5, 'https://firestore.googleapis.com/x'), startJob(5, 'https://firestore.googleapis.com/x')]));
    expect(open).toMatchObject({ netError: null, google: true });
  });
});

describe('readNetLog', () => {
  test('reads a log the browser closed', () => {
    expect(readNetLog(chromiumLayout(PAGE_EVENTS)).events).toHaveLength(PAGE_EVENTS.length);
  });

  test('reads every whole line of a log cut short, dropping a half-written last line', () => {
    const whole = chromiumLayout(PAGE_EVENTS, false);
    const cut = `${whole}{"phase":1,"source":{"id":`;
    const log = readNetLog(cut);
    expect(log.constants.logEventTypes.REQUEST_ALIVE).toBe(10);
    expect(log.events).toHaveLength(PAGE_EVENTS.length);
  });

  test('refuses text that is not a NetLog', () => {
    expect(() => readNetLog('{"something":')).toThrow('not a NetLog');
  });
});

describe('splitAddress', () => {
  test('IPv4, bracketed IPv6, and a bare host', () => {
    expect(splitAddress('169.254.169.254:80')).toEqual({ host: '169.254.169.254', port: 80 });
    expect(splitAddress('[::1]:9222')).toEqual({ host: '::1', port: 9222 });
    expect(splitAddress('localhost')).toEqual({ host: 'localhost', port: 0 });
  });
});
