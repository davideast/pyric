import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EXPECTED_PLANTS, type ExpectedPlants } from './canary/plant-names.ts';
import { judgeBrowserPlant, judgeCanary as judgeAgainst, judgeNodeLocal, judgeNodePlant, judgePlantSet, plantSegments, type CanaryObservations } from './canary/verdict.ts';
import type { NetworkEvent, NodeNetworkEvent } from './recorder/network-record.ts';

const TIME = '2026-10-29T00:00:00.000Z';
const LOCAL_PAGE = 'http://127.0.0.1:5173/local.txt';
const WEBSOCKET = 'wss://demo-x-default-rtdb.firebaseio.com/.ws?v=5';
const METADATA = '169.254.169.254';
const PLANTS_PID = 1;

function nodeEvent(host: string, kind: 'request' | 'connect', action: 'refused' | 'allowed' | 'recorded', google: boolean, pid = PLANTS_PID): NodeNetworkEvent {
  return { time: TIME, layer: 'node', pid, thread: 0, process: 'node node-plants.mjs', kind, via: kind === 'request' ? 'undici' : 'socket', host, google, catalogGap: false, metadata: host === METADATA, action };
}

function marker(plant: string, pid = PLANTS_PID): NodeNetworkEvent {
  return { time: TIME, layer: 'node', pid, thread: 0, process: 'node-plants.mjs', kind: 'plant', via: 'canary', plant };
}

const NET_ERROR_NAMES = new Map<number | null, string>([[-105, 'ERR_NAME_NOT_RESOLVED'], [-109, 'ERR_ADDRESS_UNREACHABLE']]);

function browserRequest(url: string, netError: number | null, google: boolean): NetworkEvent {
  const netErrorName = NET_ERROR_NAMES.get(netError);
  return { time: TIME, layer: 'browser', kind: 'request', via: 'netlog', source: 1, url, netError, ...(netErrorName ? { netErrorName } : {}), host: new URL(url).hostname, google, catalogGap: false, metadata: false };
}

function resolverQuery(host: string): NetworkEvent {
  return { time: TIME, layer: 'namespace', kind: 'dns', via: 'resolver', queryType: 'A', host, google: true, catalogGap: true, metadata: false, action: 'refused' };
}

function catchAll(address: string, port = 80): NetworkEvent {
  return { time: TIME, layer: 'namespace', kind: 'connect', via: 'catch-all', address, port, host: address, google: false, catalogGap: false, metadata: address === METADATA, action: 'refused' };
}

function tcp(address: string, host: string): NetworkEvent {
  return { time: TIME, layer: 'browser', kind: 'connect', via: 'netlog', source: 2, protocol: 'tcp', address, port: 5173, host, google: false, catalogGap: false, metadata: false };
}

const FETCH_METADATA = 'fetch to the metadata server by address';
const SOCKET_METADATA = 'raw socket to the metadata server';
const LOCAL = 'local request';

function passing(): CanaryObservations {
  return {
    node: {
      plants: [
        { name: 'fetch to Cloud Firestore', host: 'firestore.googleapis.com', outcome: 'failed: PYRIC_BUILDER_REFUSED' },
        { name: FETCH_METADATA, host: METADATA, outcome: 'failed: PYRIC_BUILDER_REFUSED' },
        { name: SOCKET_METADATA, host: METADATA, outcome: 'failed: PYRIC_BUILDER_REFUSED' },
      ],
      local: { name: LOCAL, url: LOCAL_PAGE, outcome: 'succeeded' },
    },
    browser: {
      plants: [{ name: 'WebSocket to the Realtime Database', url: WEBSOCKET, outcome: 'failed: websocket error' }],
      local: { url: LOCAL_PAGE, outcome: 'succeeded' },
    },
    unhooked: {
      plants: [
        { name: 'Bun fetch to oauth2', host: 'oauth2.googleapis.com', outcome: 'failed: ConnectionRefused' },
        { name: 'Bun fetch to the metadata server', host: METADATA, outcome: 'failed: ECONNRESET' },
      ],
    },
    record: [
      marker('fetch to Cloud Firestore'),
      nodeEvent('firestore.googleapis.com', 'request', 'recorded', true),
      nodeEvent('firestore.googleapis.com', 'connect', 'refused', true),
      marker(FETCH_METADATA),
      nodeEvent(METADATA, 'request', 'recorded', false),
      nodeEvent(METADATA, 'connect', 'refused', false),
      marker(SOCKET_METADATA),
      nodeEvent(METADATA, 'connect', 'refused', false),
      marker(LOCAL),
      nodeEvent('127.0.0.1', 'connect', 'allowed', false),
      browserRequest(WEBSOCKET, -105, true),
      browserRequest(LOCAL_PAGE, 0, false),
      tcp('127.0.0.1:5173', '127.0.0.1'),
      resolverQuery('oauth2.googleapis.com'),
      catchAll(METADATA),
    ],
  };
}

/** The plants `passing()` reports, as the expected set its verdicts are judged against. */
function expectedOf(observations: CanaryObservations): ExpectedPlants {
  const names = (plants: readonly { name: string }[]) => plants.map((plant) => plant.name);
  return { node: names(observations.node.plants), browser: names(observations.browser.plants), unhooked: names(observations.unhooked.plants) };
}

const FIXTURE_PLANTS = expectedOf(passing());

const judgeCanary = (observations: CanaryObservations) => judgeAgainst(observations, FIXTURE_PLANTS);

function failedChecks(observations: CanaryObservations): string[] {
  return judgeCanary(observations).checks.filter((check) => !check.ok).map((check) => check.name);
}

/** The record without the events after `plant`'s marker, up to the next marker. */
function withoutOwnEvents(record: NetworkEvent[], plant: string): NetworkEvent[] {
  let inside = false;
  return record.filter((event) => {
    if (event.layer === 'node' && event.kind === 'plant') inside = event.plant === plant;
    else if (inside && event.layer === 'node') return false;
    return true;
  });
}

describe('judgeCanary', () => {
  test('passes when every plant was recorded and failed and the local requests worked', () => {
    const verdict = judgeCanary(passing());
    expect(verdict.checks.filter((check) => !check.ok)).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.googleEvents).toBe(8);
  });

  test('fails a Node plant missing from the record', () => {
    const observations = passing();
    observations.record = observations.record.filter((event) => !('host' in event && event.host === 'firestore.googleapis.com'));
    expect(failedChecks(observations)).toEqual(['node: fetch to Cloud Firestore']);
  });

  test('judges each Node plant by its own events, not another plant’s to the same host', () => {
    const observations = passing();
    observations.record = withoutOwnEvents(observations.record, SOCKET_METADATA);
    expect(failedChecks(observations)).toEqual([`node: ${SOCKET_METADATA}`]);
  });

  test('fails a Node plant with no marker line', () => {
    const observations = passing();
    observations.record = observations.record.filter((event) => !(event.layer === 'node' && event.kind === 'plant' && event.plant === FETCH_METADATA));
    expect(failedChecks(observations)).toContain(`node: ${FETCH_METADATA}`);
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
    observations.record.splice(3, 0, nodeEvent('firestore.googleapis.com', 'connect', 'allowed', true));
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
    observations.record = observations.record.filter((event) => !(event.layer === 'namespace' && event.kind === 'dns'));
    expect(failedChecks(observations)).toEqual(['unhooked: Bun fetch to oauth2']);
  });

  test('fails an unhooked plant by address that failed without reaching the catch-all listener', () => {
    const observations = passing();
    observations.record = observations.record.filter((event) => !(event.layer === 'namespace' && event.kind === 'connect'));
    const verdict = judgeCanary(observations);
    const check = verdict.checks.find((candidate) => candidate.name === 'unhooked: Bun fetch to the metadata server');
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('its connection is missing from the record');
    expect(failedChecks(observations)).toEqual(['unhooked: Bun fetch to the metadata server']);
  });

  test('fails when a hooked layer’s lookup reached the sandbox resolver', () => {
    const observations = passing();
    observations.record.push(resolverQuery('firestore.googleapis.com'));
    expect(failedChecks(observations)).toEqual(['sandbox: only the unhooked plants reached the resolver']);
  });

  test('fails when a hooked layer’s connection reached the catch-all listener', () => {
    const observations = passing();
    observations.record.push(catchAll('142.250.0.1', 443));
    expect(failedChecks(observations)).toEqual(['sandbox: only the unhooked plants reached the catch-all listener']);
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

describe('the expected plant set', () => {
  test('fails a side that reported no plants, where every per-plant check would pass trivially', () => {
    const observations = passing();
    observations.node.plants = [];
    observations.browser.plants = [];
    observations.unhooked.plants = [];
    const failed = failedChecks(observations);
    for (const side of ['node', 'browser', 'unhooked']) expect(failed).toContain(`${side}: every expected plant reported`);
  });

  test('names a missing plant and one not expected', () => {
    const check = judgePlantSet('node', [{ name: 'a' }, { name: 'c' }], ['a', 'b']);
    expect(check.ok).toBe(false);
    expect(check.detail).toBe('missing: b; not expected: c');
  });

  test('fails a plant reported twice', () => {
    expect(judgePlantSet('node', [{ name: 'a' }, { name: 'a' }], ['a']).ok).toBe(false);
  });

  const sources = [
    ['node', './canary/app/node-plants.mjs', EXPECTED_PLANTS.node],
    ['browser', './canary/browser-plants.ts', EXPECTED_PLANTS.browser],
    ['unhooked', './canary/plant-phase.ts', EXPECTED_PLANTS.unhooked],
  ] as const;
  for (const [side, file, names] of sources) {
    test(`every expected ${side} plant is planted by ${file}`, () => {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const name of names) expect(source).toContain(`'${name}'`);
    });
  }
});

describe('plantSegments', () => {
  test('gives each plant the events its own process wrote after its marker', () => {
    const segments = plantSegments([
      marker('a'),
      nodeEvent('x.googleapis.com', 'connect', 'refused', true),
      nodeEvent('vite.local', 'connect', 'allowed', false, 2),
      marker('b'),
      nodeEvent('y.googleapis.com', 'connect', 'refused', true),
    ]);
    expect(segments.get('a')?.map((event) => event.host)).toEqual(['x.googleapis.com']);
    expect(segments.get('b')?.map((event) => event.host)).toEqual(['y.googleapis.com']);
  });
});

describe('judgeNodePlant', () => {
  const plant = { name: SOCKET_METADATA, host: METADATA, outcome: 'failed: PYRIC_BUILDER_REFUSED' };
  const own = [nodeEvent(METADATA, 'connect', 'refused', false)];

  test('passes a plant recorded and refused by the recorder', () => {
    expect(judgeNodePlant(plant, own).ok).toBe(true);
  });

  test('fails a plant with no events of its own', () => {
    expect(judgeNodePlant(plant, []).ok).toBe(false);
  });

  test('fails a plant whose own events are for another host', () => {
    expect(judgeNodePlant(plant, [nodeEvent('firestore.googleapis.com', 'connect', 'refused', true)]).ok).toBe(false);
  });
});

describe('judgeNodeLocal', () => {
  const local = { name: LOCAL, url: LOCAL_PAGE, outcome: 'succeeded' };
  const own = [nodeEvent('127.0.0.1', 'connect', 'allowed', false)];

  test('passes a local request that worked, is recorded, and is not flagged', () => {
    expect(judgeNodeLocal(local, own).ok).toBe(true);
  });

  test('fails a local request that failed', () => {
    expect(judgeNodeLocal({ ...local, outcome: 'failed: ECONNREFUSED' }, own).ok).toBe(false);
  });

  test('fails a local request the recorder never saw', () => {
    expect(judgeNodeLocal(local, []).ok).toBe(false);
  });

  test('fails a local request flagged as Google', () => {
    expect(judgeNodeLocal(local, [nodeEvent('127.0.0.1', 'connect', 'allowed', true)]).ok).toBe(false);
  });
});

describe('judgeBrowserPlant', () => {
  const plant = { name: 'WebSocket to the Realtime Database', url: WEBSOCKET, outcome: 'failed: websocket error' };
  const requests = (netError: number | null, google = true) => [browserRequest(WEBSOCKET, netError, google)] as Parameters<typeof judgeBrowserPlant>[1];

  test('passes a plant the NetLog has, flagged, refused by the resolver rules', () => {
    expect(judgeBrowserPlant(plant, requests(-105)).ok).toBe(true);
  });

  test('fails a plant missing from the NetLog', () => {
    expect(judgeBrowserPlant(plant, []).ok).toBe(false);
  });

  test('fails a plant that completed', () => {
    expect(judgeBrowserPlant(plant, requests(0)).ok).toBe(false);
  });

  test('fails a plant that failed some other way than the resolver rules', () => {
    expect(judgeBrowserPlant(plant, requests(-109)).ok).toBe(false);
  });

  test('fails a plant the page saw succeed', () => {
    expect(judgeBrowserPlant({ ...plant, outcome: 'succeeded' }, requests(-105)).ok).toBe(false);
  });

  test('fails a plant the NetLog has but did not flag as Google', () => {
    expect(judgeBrowserPlant(plant, requests(-105, false)).ok).toBe(false);
  });
});
