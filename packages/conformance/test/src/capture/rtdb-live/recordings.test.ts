/**
 * The two production recordings the live-mode RTDB work replays and calibrates
 * against (issue #2114, steps 2 and 6): their shape, and that no credential,
 * project id or instance name survived redaction.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORDINGS = join(dirname(fileURLToPath(import.meta.url)), '../../../../src/capture/rtdb-live/recordings');

function recording(file: string): { text: string; json: Record<string, unknown> } {
  const text = readFileSync(join(RECORDINGS, file), 'utf8');
  return { text, json: JSON.parse(text) as Record<string, unknown> };
}

/** Written out here rather than imported, so a gap in the capture's own list cannot hide a leak. */
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ['JWT (ID token, custom token)', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['Google OAuth access token', /ya29\.[A-Za-z0-9_-]{10,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['Firebase refresh token', /AMf-v[A-Za-z0-9_-]{20,}/],
  ['Google refresh token', /1\/\/0[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer header', /Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ['access_token query', /access_token=[^&"<]{10,}/],
];

const FIREBASE_HOST = /([A-Za-z0-9<>_-]+)\.(?:firebaseio\.com|firebasedatabase\.app)/g;
/** A database host is a redacted instance placeholder or a server shard (`s-gke-usc1-nssi2-16`). */
const ALLOWED_HOST = /^(?:<default-instance>|<named-instance>|s-gke-[a-z0-9-]+)$/;
const UID_FIELD = /"(?:uid|user_id|sub)\\?"\s*:\s*\\?"([^"\\]*)/g;

/**
 * The project id and instance names the captures ran against, from the same
 * env variables the scripts read. Committed code names none of them, so this
 * check runs only where they are set.
 */
function capturedNames(): string[] {
  const names = [process.env.PYRIC_ORACLE_PROJECT_ID ?? ''];
  for (const variable of ['PYRIC_STAGING_RTDB', 'PYRIC_STAGING_RTDB_NAMED']) {
    const url = process.env[variable];
    if (url) names.push(new URL(url).hostname.split('.')[0]!);
  }
  return names.filter((name) => name !== '');
}
const CAPTURED_NAMES = capturedNames();

function expectNoCapturedNames(text: string): void {
  for (const name of CAPTURED_NAMES) expect({ name, present: text.includes(name) }).toEqual({ name, present: false });
}

function expectRedacted(text: string): void {
  for (const [label, pattern] of CREDENTIAL_PATTERNS) {
    expect({ label, match: pattern.exec(text)?.[0] ?? null }).toEqual({ label, match: null });
  }
  for (const [, host] of text.matchAll(FIREBASE_HOST)) expect(host).toMatch(ALLOWED_HOST);
  for (const [, uid] of text.matchAll(UID_FIELD)) expect(uid).toMatch(/^<uid-\d+>$/);
  expect(text).not.toMatch(/securetoken\.google\.com\/(?!<project>)/);
  expect(text).not.toMatch(/[?&](?:ls|p)=(?!<)/);
}

const WIRE_OPERATIONS = [
  'connect', 'set', 'get', 'update', 'push', 'runTransaction', 'onValue', 'onChildAdded',
  'denied-read', 'denied-write', 'onDisconnect',
];

interface WireFrame { t: number; dir: string; client: string; connection: number; op: string; data: string }
interface WireConnection { id: number; client: string; url: string; openedAtMs: number }
interface WireInstance {
  instance: string;
  connections: WireConnection[];
  frames: WireFrame[];
  results: Record<string, unknown>;
  invariants: { dataRemoved: boolean; rulesRestored: boolean };
}

describe('capture A: RTDB wire recording', () => {
  const { text, json } = recording('capture-a-wire.json');

  test('names the SDK, the run path and every operation', () => {
    expect(json.name).toBe('rtdb-live-capture-a-wire');
    expect(json.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(json.runPath).toBe('/pyric-live-capture/<run>');
    expect(json.operations).toEqual(expect.arrayContaining(WIRE_OPERATIONS));
  });

  test.each(['default', 'named'])('the %s instance has frames in both directions for every operation', (label) => {
    const instance = (json.instances as Record<string, WireInstance>)[label]!;
    expect(instance.instance).toBe(`<${label}-instance>`);
    expect(instance.invariants).toEqual({ dataRemoved: true, rulesRestored: true });
    const connectionIds = new Set(instance.connections.map((c) => c.id));
    for (const connection of instance.connections) expect(connection.url).toContain(`<${label}-instance>`);
    let previous = 0;
    for (const frame of instance.frames) {
      expect(frame.t).toBeGreaterThanOrEqual(previous);
      previous = frame.t;
      expect(['sent', 'received']).toContain(frame.dir);
      expect(connectionIds.has(frame.connection)).toBe(true);
      expect(json.operations as string[]).toContain(frame.op);
      expect(typeof frame.data).toBe('string');
    }
    for (const op of WIRE_OPERATIONS) {
      const frames = instance.frames.filter((f) => f.op === op);
      expect({ op, sent: frames.some((f) => f.dir === 'sent') }).toEqual({ op, sent: true });
      expect({ op, received: frames.some((f) => f.dir === 'received') }).toEqual({ op, received: true });
    }
  });

  test.each(['default', 'named'])('the %s instance denied /secret and ran the onDisconnect write', (label) => {
    const instance = (json.instances as Record<string, WireInstance>)[label]!;
    for (const op of ['denied-read', 'denied-write']) {
      const denied = instance.frames.some((f) => f.op === op && f.dir === 'received' && f.data.includes('permission_denied'));
      expect({ op, denied }).toEqual({ op, denied: true });
    }
    expect(instance.results.onDisconnect).toEqual({ readBack: 'offline' });
  });

  test('is redacted', () => expectRedacted(text));
  test.skipIf(CAPTURED_NAMES.length === 0)('names neither the project nor an instance it ran against', () => expectNoCapturedNames(text));
});

const BANDWIDTH_OPERATIONS = [
  'onValue-initial-10kb', 'child-update-100b-with-listener', 'get-with-listener', 'get-without-listener',
  'push', 'transaction-contended', 'onDisconnect',
];

interface BandwidthOperation {
  op: string;
  bytesDown: number;
  bytesUp: number;
  events: Array<{ name: string; bytes: number | null; t: number }>;
  wire: { sent: number; received: number };
}

describe('capture B: RTDB bandwidth calibration', () => {
  const { text, json } = recording('capture-b-bandwidth.json');

  test('names the SDK, the profiler and the instance', () => {
    expect(json.name).toBe('rtdb-live-capture-b-bandwidth');
    expect(json.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(json.firebaseToolsVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(json.instance).toBe('<default-instance>');
    expect(json.invariants).toEqual({ dataRemoved: true, rulesRestored: true, markerSeen: true });
  });

  test('records bytes down and up for every operation', () => {
    const operations = json.operations as BandwidthOperation[];
    expect(operations.map((o) => o.op)).toEqual(expect.arrayContaining(BANDWIDTH_OPERATIONS));
    for (const operation of operations) {
      expect(operation.bytesDown).toBeGreaterThanOrEqual(0);
      expect(operation.bytesUp).toBeGreaterThanOrEqual(0);
      expect(operation.wire.sent).toBeGreaterThanOrEqual(0);
      expect(operation.wire.received).toBeGreaterThanOrEqual(0);
    }
    const initial = operations.find((o) => o.op === 'onValue-initial-10kb')!;
    expect(initial.bytesDown).toBeGreaterThanOrEqual(10_000);
    const contended = operations.find((o) => o.op === 'transaction-contended')!;
    expect(contended.events.length).toBeGreaterThan(0);
  });

  test('is redacted', () => expectRedacted(text));
  test.skipIf(CAPTURED_NAMES.length === 0)('names neither the project nor an instance it ran against', () => expectNoCapturedNames(text));
});
