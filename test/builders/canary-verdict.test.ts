import { describe, expect, test } from 'bun:test';
import { judgeCanary, type CanaryObservations } from './canary/verdict.ts';
import type { NetworkEvent } from './recorder/network-record.ts';

const TIME = '2026-10-29T00:00:00.000Z';
const LOCAL_PAGE = 'http://127.0.0.1:5173/local.txt';
const WEBSOCKET = 'wss://demo-x-default-rtdb.firebaseio.com/.ws?v=5';

function nodeEvent(host: string, kind: 'request' | 'connect', action: 'refused' | 'allowed' | 'recorded', google: boolean): NetworkEvent {
  return { time: TIME, layer: 'node', pid: 1, thread: 0, process: 'node node-plants.mjs', kind, via: kind === 'request' ? 'undici' : 'socket', host, google, catalogGap: false, metadata: false, action };
}

const NET_ERROR_NAMES = new Map<number | null, string>([[-105, 'ERR_NAME_NOT_RESOLVED'], [-109, 'ERR_ADDRESS_UNREACHABLE']]);

function browserRequest(url: string, netError: number | null, google: boolean): NetworkEvent {
  const netErrorName = NET_ERROR_NAMES.get(netError);
  return { time: TIME, layer: 'browser', kind: 'request', via: 'netlog', source: 1, url, netError, ...(netErrorName ? { netErrorName } : {}), host: new URL(url).hostname, google, catalogGap: false, metadata: false };
}

function resolverQuery(host: string): NetworkEvent {
  return { time: TIME, layer: 'namespace', kind: 'dns', via: 'resolver', queryType: 'A', host, google: true, catalogGap: true, metadata: false, action: 'refused' };
}

function tcp(address: string, host: string): NetworkEvent {
  return { time: TIME, layer: 'browser', kind: 'connect', via: 'netlog', source: 2, protocol: 'tcp', address, port: 5173, host, google: false, catalogGap: false, metadata: false };
}

function passing(): CanaryObservations {
  return {
    node: {
      plants: [{ name: 'fetch to Cloud Firestore', host: 'firestore.googleapis.com', outcome: 'failed: PYRIC_BUILDER_REFUSED' }],
      local: { url: LOCAL_PAGE, outcome: 'succeeded' },
    },
    browser: {
      plants: [{ name: 'WebSocket to the Realtime Database', url: WEBSOCKET, outcome: 'failed: websocket error' }],
      local: { url: LOCAL_PAGE, outcome: 'succeeded' },
    },
    unhooked: {
      plants: [
        { name: 'Bun fetch to oauth2', host: 'oauth2.googleapis.com', outcome: 'failed: ConnectionRefused' },
        { name: 'Bun fetch to the metadata server', host: '169.254.169.254', outcome: 'failed: ConnectionRefused' },
      ],
    },
    record: [
      nodeEvent('firestore.googleapis.com', 'request', 'recorded', true),
      nodeEvent('firestore.googleapis.com', 'connect', 'refused', true),
      nodeEvent('127.0.0.1', 'connect', 'allowed', false),
      browserRequest(WEBSOCKET, -105, true),
      browserRequest(LOCAL_PAGE, 0, false),
      tcp('127.0.0.1:5173', '127.0.0.1'),
      resolverQuery('oauth2.googleapis.com'),
    ],
  };
}

function failedChecks(observations: CanaryObservations): string[] {
  return judgeCanary(observations).checks.filter((check) => !check.ok).map((check) => check.name);
}

describe('judgeCanary', () => {
  test('passes when every plant was recorded and failed and the local requests worked', () => {
    const verdict = judgeCanary(passing());
    expect(verdict.ok).toBe(true);
    expect(verdict.googleEvents).toBe(4);
  });

  test('fails a Node plant missing from the record', () => {
    const observations = passing();
    observations.record = observations.record.filter((event) => event.host !== 'firestore.googleapis.com');
    expect(failedChecks(observations)).toEqual(['node: fetch to Cloud Firestore']);
  });

  test('fails a Node plant the namespace stopped but the recorder did not', () => {
    const observations = passing();
    observations.node.plants[0]!.outcome = 'failed: ENETUNREACH';
    expect(failedChecks(observations)).toEqual(['node: fetch to Cloud Firestore']);
  });

  test('fails a Node plant that succeeded', () => {
    const observations = passing();
    observations.node.plants[0]!.outcome = 'succeeded';
    expect(failedChecks(observations)).toEqual(['node: fetch to Cloud Firestore']);
  });

  test('fails when the recorder allowed a Google host', () => {
    const observations = passing();
    observations.record.push(nodeEvent('firestore.googleapis.com', 'connect', 'allowed', true));
    expect(failedChecks(observations)).toEqual(['node: fetch to Cloud Firestore', 'node: no Google host or metadata connection allowed']);
  });

  test('fails a browser plant the NetLog does not have, the gap context.route leaves (#1606)', () => {
    const observations = passing();
    observations.record = observations.record.filter((event) => !('url' in event && event.url === WEBSOCKET));
    expect(failedChecks(observations)).toEqual(['browser: WebSocket to the Realtime Database']);
  });

  test('fails a browser plant that completed', () => {
    const observations = passing();
    observations.record = observations.record.map((event) => ('url' in event && event.url === WEBSOCKET ? browserRequest(WEBSOCKET, 0, true) : event));
    expect(failedChecks(observations)).toEqual(['browser: WebSocket to the Realtime Database']);
  });

  test('fails a browser plant the namespace stopped but the resolver rules did not', () => {
    const observations = passing();
    observations.record = observations.record.map((event) => ('url' in event && event.url === WEBSOCKET ? browserRequest(WEBSOCKET, -109, true) : event));
    expect(failedChecks(observations)).toEqual(['browser: WebSocket to the Realtime Database']);
  });

  test('fails an unhooked plant that succeeded', () => {
    const observations = passing();
    observations.unhooked.plants[1]!.outcome = 'succeeded';
    expect(failedChecks(observations)).toEqual(['unhooked: Bun fetch to the metadata server']);
  });

  test('fails an unhooked plant whose lookup the resolver did not record', () => {
    const observations = passing();
    observations.record = observations.record.filter((event) => event.layer !== 'namespace');
    expect(failedChecks(observations)).toEqual(['unhooked: Bun fetch to oauth2']);
  });

  test('fails when a hooked layer’s lookup reached the namespace resolver', () => {
    const observations = passing();
    observations.record.push(resolverQuery('firestore.googleapis.com'));
    expect(failedChecks(observations)).toEqual(['namespace: only the unhooked plants reached the resolver']);
  });

  test('fails when the local request was blocked or flagged', () => {
    const observations = passing();
    observations.browser.local.outcome = 'failed: Failed to fetch';
    observations.node.local.outcome = 'failed: PYRIC_BUILDER_REFUSED';
    expect(failedChecks(observations)).toEqual(['node: local request to http://127.0.0.1:5173/local.txt', 'browser: local request to http://127.0.0.1:5173/local.txt']);
  });

  test('fails when a browser socket left loopback', () => {
    const observations = passing();
    observations.record.push(tcp('142.250.0.1:443', '142.250.0.1'));
    expect(failedChecks(observations)).toEqual(['browser: no TCP socket left loopback']);
  });
});
