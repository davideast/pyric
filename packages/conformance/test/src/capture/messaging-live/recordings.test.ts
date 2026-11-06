/**
 * Capture M, the production recording the live-mode Messaging replay serves
 * (issue #2114, Messaging M-1): every exchange the plan lists is present, the
 * three denials carry production's status and body, the push payload key
 * sets are present, cleanup held, and no credential survived redaction.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORDING = join(dirname(fileURLToPath(import.meta.url)), '../../../../src/capture/messaging-live/recordings/capture-m-wire.json');

interface Exchange {
  op: string;
  api: 'installations' | 'registrations';
  action: string;
  method: string;
  host: string;
  path: string;
  requestHeaderNames: string[];
  requestContentType: string | null;
  requestBodyKeys: string[];
  status: number | null;
  responseHeaderNames: string[];
  responseHeaders: Record<string, string>;
  responseBody: unknown;
}

interface Call {
  op: string;
  app: string;
  call: string;
  outcome: 'ok' | 'error';
  sameAsPrevious?: boolean;
  error?: { code: string | null; message: string; customData: unknown };
}

interface Push {
  op: string;
  route: 'foreground' | 'background';
  pushData: Record<string, unknown>;
  delivered: { to: string; payload: Record<string, unknown> };
}

interface Recording {
  name: string;
  sdkVersion: string;
  browser: { channel: string; headless: boolean };
  operations: string[];
  exchanges: Exchange[];
  calls: Call[];
  pushes: Push[];
  denials: Record<string, { op: string; api: string; action: string; status: number; body: { error?: { code?: number; status?: string; message?: string } } }>;
  apiKeys: { before: number; created: number; after: number };
  invariants: Record<string, boolean>;
}

const text = readFileSync(RECORDING, 'utf8');
const recording = JSON.parse(text) as Recording;

const OPERATIONS = [
  'getToken', 'getToken-again', 'onMessage', 'onBackgroundMessage', 'getToken-reload', 'deleteToken',
  'getToken-after-delete', 'deleteToken-again', 'delete-deleted-token',
  'denied-malformed-key', 'denied-referrer', 'denied-installations-only', 'cleanup',
];

function exchangesOf(op: string): Exchange[] {
  return recording.exchanges.filter((e) => e.op === op);
}

function only(op: string, api: Exchange['api'], action: string): Exchange {
  const found = exchangesOf(op).filter((e) => e.api === api && e.action === action);
  expect({ op, api, action, count: found.length }).toEqual({ op, api, action, count: 1 });
  return found[0]!;
}

/** Written out here rather than imported, so a gap in the capture's own list cannot hide a leak. */
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ['JWT (Installations auth token)', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['Google OAuth access token', /ya29\.[A-Za-z0-9_-]{10,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['Firebase refresh token', /AMf-v[A-Za-z0-9_-]{20,}/],
  ['Google refresh token', /1\/\/0[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer header', /Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ['FCM registration token', /APA91b[A-Za-z0-9_-]{20,}/],
  ['push endpoint', /\/fcm\/send\/[A-Za-z0-9_:-]{10,}/],
  ['Installations auth header', /FIS(?:_v2)?\s+[A-Za-z0-9._-]{20,}/],
  ['Installations refresh token', /\b\d_[A-Za-z0-9_-]{30,}/],
  ['service account', /@[A-Za-z0-9.-]+\.gserviceaccount\.com/],
  ['project number in a resource name', /projects\/\d{6,}/],
  ['FID field', /"fid"\s*:\s*"(?!<fid-\d+>)/],
  ['refresh token field', /"refreshToken"\s*:\s*"(?!<refresh-token-\d+>)/],
];

/** The project the capture ran on, from the variables the script reads. Committed code names none. */
function capturedNames(): string[] {
  const names = [process.env.PYRIC_MESSAGING_PROJECT_ID ?? '', process.env.PYRIC_ORACLE_PROJECT_ID ?? ''];
  try {
    const config = JSON.parse(process.env.PYRIC_MESSAGING_FIREBASE_CONFIG ?? '{}') as Record<string, string>;
    names.push(config.projectId ?? '', config.messagingSenderId ?? '', config.appId ?? '', config.apiKey ?? '');
  } catch {
    // An unreadable config names nothing.
  }
  if (process.env.PYRIC_MESSAGING_VAPID_KEY) names.push(process.env.PYRIC_MESSAGING_VAPID_KEY);
  return names.filter((name) => name !== '');
}
const CAPTURED_NAMES = capturedNames();

describe('capture M: Messaging wire recording', () => {
  test('names the SDK, the browser and every operation', () => {
    expect(recording.name).toBe('messaging-live-capture-m-wire');
    expect(recording.sdkVersion).toMatch(/^12\.\d+\.\d+/);
    expect(recording.browser.headless).toBe(false);
    expect(recording.operations).toEqual(expect.arrayContaining(OPERATIONS));
    for (const exchange of recording.exchanges) expect(recording.operations).toContain(exchange.op);
  });

  test('cleanup held: tokens, installations and both restricted keys deleted and read back', () => {
    expect(recording.invariants).toEqual({ tokensDeleted: true, installationsDeleted: true, keysDeleted: true });
    expect(recording.apiKeys).toMatchObject({ before: 0, created: 2, after: 0 });
  });

  test('the first getToken on a fresh profile creates an installation and a registration', () => {
    const installation = only('getToken', 'installations', 'create');
    expect(installation.method).toBe('POST');
    expect(installation.path).toBe('/v1/projects/<project>/installations');
    expect(installation.status).toBe(200);
    expect(installation.requestBodyKeys).toEqual(expect.arrayContaining(['appId', 'authVersion', 'fid', 'sdkVersion']));
    expect(installation.responseBody).toMatchObject({ fid: expect.stringMatching(/^<fid-\d+>$/), refreshToken: expect.any(String), authToken: { token: expect.any(String), expiresIn: expect.any(String) } });
    const registration = only('getToken', 'registrations', 'create');
    expect(registration.path).toBe('/v1/projects/<project>/registrations');
    expect(registration.status).toBe(200);
    expect(registration.requestHeaderNames).toEqual(expect.arrayContaining(['x-goog-api-key', 'x-goog-firebase-installations-auth']));
    expect(registration.requestBodyKeys).toEqual(expect.arrayContaining(['web.auth', 'web.endpoint', 'web.p256dh']));
    expect(registration.responseBody).toMatchObject({ token: expect.stringMatching(/^<fcm-token-\d+>$/) });
  });

  test('a getToken answered from the stored token sends no request', () => {
    for (const op of ['getToken-again', 'getToken-reload']) {
      expect({ op, exchanges: exchangesOf(op).length }).toEqual({ op, exchanges: 0 });
      const call = recording.calls.find((c) => c.op === op)!;
      expect({ op, outcome: call.outcome, same: call.sameAsPrevious }).toEqual({ op, outcome: 'ok', same: true });
    }
  });

  test('deleteToken deletes the registration, and a second token is minted and deleted', () => {
    for (const op of ['deleteToken', 'deleteToken-again']) {
      const deleted = only(op, 'registrations', 'delete');
      expect(deleted.method).toBe('DELETE');
      expect(deleted.path).toMatch(/^\/v1\/projects\/<project>\/registrations\/<fcm-token-\d+>$/);
      expect(deleted.status).toBe(200);
    }
    expect(only('getToken-after-delete', 'registrations', 'create').status).toBe(200);
    const first = only('deleteToken', 'registrations', 'delete').path;
    const second = only('deleteToken-again', 'registrations', 'delete').path;
    expect(first).not.toBe(second);
  });

  test('a DELETE of a deleted token has production answer', () => {
    const again = only('delete-deleted-token', 'registrations', 'delete');
    expect(again.path).toBe(only('deleteToken-again', 'registrations', 'delete').path);
    expect(again.status).toEqual(expect.any(Number));
  });

  test('the three denials carry production status and body', () => {
    const expected: Record<string, { api: string; action: string; status: number }> = {
      'malformed-key': { api: 'installations', action: 'create', status: 400 },
      'referrer-blocked': { api: 'installations', action: 'create', status: 403 },
      'installations-only': { api: 'registrations', action: 'create', status: 403 },
    };
    for (const [kind, want] of Object.entries(expected)) {
      const denial = recording.denials[kind]!;
      expect({ kind, api: denial.api, action: denial.action, status: denial.status }).toEqual({ kind, ...want });
      expect(denial.body.error).toMatchObject({ code: want.status, status: expect.any(String), message: expect.any(String) });
      const exchange = only(denial.op, want.api as Exchange['api'], want.action);
      expect(exchange.status).toBe(want.status);
      expect(exchange.responseBody).toEqual(denial.body);
      const call = recording.calls.find((c) => c.op === denial.op)!;
      expect({ kind, outcome: call.outcome, code: typeof call.error?.code }).toEqual({ kind, outcome: 'error', code: 'string' });
    }
    expect(recording.denials['referrer-blocked']!.body.error!.status).toBe('PERMISSION_DENIED');
    expect(recording.denials['installations-only']!.body.error!.status).toBe('PERMISSION_DENIED');
    expect(only('denied-installations-only', 'installations', 'create').status).toBe(200);
  });

  test('every answered exchange keeps its content type and its header names', () => {
    for (const exchange of recording.exchanges.filter((e) => e.status !== null)) {
      expect(exchange.responseHeaders['content-type']).toEqual(expect.any(String));
      expect(exchange.responseHeaderNames.length).toBeGreaterThan(0);
    }
  });

  test('the foreground and background pushes keep their payload key sets', () => {
    const routes: Record<Push['route'], string> = { foreground: 'onMessage', background: 'onBackgroundMessage' };
    for (const [route, to] of Object.entries(routes)) {
      const push = recording.pushes.find((p) => p.route === route)!;
      expect(push.op).toBe(to);
      expect(Object.keys(push.pushData)).toEqual(expect.arrayContaining(['data', 'from', 'notification']));
      expect(push.pushData.data).toMatchObject({ tag: route });
      expect(push.delivered.to).toBe(to);
      expect(Object.keys(push.delivered.payload)).toEqual(expect.arrayContaining(['data', 'from', 'messageId', 'notification']));
      expect(push.delivered.payload.data).toMatchObject({ tag: route });
    }
  });

  test('is redacted', () => {
    for (const [label, pattern] of CREDENTIAL_PATTERNS) {
      expect({ label, match: pattern.exec(text)?.[0] ?? null }).toEqual({ label, match: null });
    }
    for (const exchange of recording.exchanges) expect(exchange.path).toMatch(/^\/v1\/projects\/<project>\//);
  });

  test.skipIf(CAPTURED_NAMES.length === 0)('names neither the project nor its config it ran against', () => {
    for (const name of CAPTURED_NAMES) expect({ length: name.length, present: text.includes(name) }).toEqual({ length: name.length, present: false });
  });
});
