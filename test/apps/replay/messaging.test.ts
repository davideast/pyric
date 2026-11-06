/**
 * The replay server answers Firebase Installations and FCM registrations, the
 * two hosts `firebase/messaging` calls in getToken and deleteToken, from a
 * minimal fixture taken from capture M. Messaging does not run in Bun (no
 * service worker or PushManager), so the requests here are the ones the SDK
 * sends, in capture M's shapes: the methods, paths, header names and body
 * keys it recorded, with the header values `@firebase/installations` 0.6 and
 * `@firebase/messaging` 0.13 build. They go through the seam, as the SDK's
 * own `fetch` would. The real SDK runs against the replay in M-3's browser
 * test.
 * Run it with the network off: `unshare -rn sh -c 'ip link set lo up && bun test test/apps/replay/messaging.test.ts'`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { assertShapesOnly, readRecording, type Recording } from './format.ts';
import { routeFirebaseTo } from './seam.ts';
import { startReplayServer, type ReplayServer } from './server.ts';

const MINIMAL = join(import.meta.dir, 'fixtures', 'messaging-minimal.json');
const PROJECT = 'demo-replay-messaging';
const INSTALLATIONS = `https://firebaseinstallations.googleapis.com/v1/projects/${PROJECT}/installations`;
const REGISTRATIONS = `https://fcmregistrations.googleapis.com/v1/projects/${PROJECT}/registrations`;
const API_KEY = 'replay-api-key';
const REFERRER_BLOCKED_KEY = 'replay-referrer-blocked-key';
const NO_RECORDING = 'pyric_replay_no_recording';
/** The headers both SDKs send on every call, in capture M's names. */
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' };

let server: ReplayServer;
let stopRouting: () => void;

beforeAll(async () => {
  server = await startReplayServer([readRecording(MINIMAL)]);
  stopRouting = routeFirebaseTo(server.origin);
});

afterAll(async () => {
  stopRouting();
  await server.close();
});

beforeEach(() => {
  server.unmatched.length = 0;
});

interface Answer {
  status: number;
  contentType: string | null;
  body: Record<string, unknown>;
}

async function send(url: string, init: RequestInit): Promise<Answer> {
  const response = await fetch(url, init);
  return { status: response.status, contentType: response.headers.get('content-type'), body: (await response.json()) as Record<string, unknown> };
}

/** `createInstallationRequest`: a FID the SDK picked, with its API key and heartbeat header. */
function createInstallation(apiKey = API_KEY, fid = 'cReplayFid0123456789ab'): Promise<Answer> {
  const body = { fid, authVersion: 'FIS_v2', appId: '1:1234567890:web:replay', sdkVersion: 'w:0.6.24' };
  return send(INSTALLATIONS, { method: 'POST', headers: { ...JSON_HEADERS, 'x-goog-api-key': apiKey, 'x-firebase-client': 'replay-heartbeat' }, body: JSON.stringify(body) });
}

/** `requestGetToken`: the push subscription's fields, the VAPID key and the registering origin, under the FIS token. */
function createRegistration(fisAuthToken: string): Promise<Answer> {
  const web = { origin: 'localhost:5173', endpoint: 'https://fcm.googleapis.com/fcm/send/test-endpoint', auth: 'test-auth', p256dh: 'test-p256dh', applicationPubKey: 'test-vapid-key' };
  return send(REGISTRATIONS, { method: 'POST', headers: registrationHeaders(fisAuthToken), body: JSON.stringify({ web }) });
}

/** `requestDeleteToken`: a DELETE on the token, with no body. */
function deleteRegistration(token: string, fisAuthToken: string): Promise<Answer> {
  return send(`${REGISTRATIONS}/${token}`, { method: 'DELETE', headers: registrationHeaders(fisAuthToken) });
}

function registrationHeaders(fisAuthToken: string): Record<string, string> {
  return { ...JSON_HEADERS, 'x-goog-api-key': API_KEY, 'x-goog-firebase-installations-auth': `FIS ${fisAuthToken}` };
}

/** A fresh installation's FIS auth token, what every registrations call carries. */
async function fisAuthToken(): Promise<string> {
  const answer = await createInstallation();
  return (answer.body.authToken as { token: string }).token;
}

describe('Installations and FCM registrations answered from capture M', () => {
  test('the fixture holds shapes only', () => {
    expect(() => assertShapesOnly(readRecording(MINIMAL))).not.toThrow();
  });

  test('an Installations create is answered with the FID the SDK sent, a refresh token and a FIS auth token', async () => {
    const answer = await createInstallation();
    expect(answer.status).toBe(200);
    expect(answer.contentType).toBe('application/json; charset=UTF-8');
    expect(answer.body).toMatchObject({
      name: 'projects/1234567890/installations/cReplayFid0123456789ab',
      fid: 'cReplayFid0123456789ab',
      authToken: { expiresIn: '604800s' },
    });
    expect(answer.body.refreshToken).toEqual(expect.any(String));
    expect((answer.body.authToken as { token: unknown }).token).toEqual(expect.any(String));
    expect(server.messaging.at(-1)).toEqual({ rpc: 'messaging', as: null, message: { api: 'installations', method: 'POST', path: `/v1/projects/${PROJECT}/installations` } });
    expect(server.unmatched).toEqual([]);
  });

  test('a registrations create under that FIS token is answered with a fresh registration token', async () => {
    const answer = await createRegistration(await fisAuthToken());
    expect(answer.status).toBe(200);
    const token = answer.body.token as string;
    expect(token).toEqual(expect.any(String));
    expect(answer.body.name).toBe(`projects/${PROJECT}/registrations/${token}`);
    const again = await createRegistration(await fisAuthToken());
    expect(again.body.token).not.toBe(token);
    expect(server.unmatched).toEqual([]);
  });

  test('a registrations delete of a token this server issued is answered 200 with an empty body', async () => {
    const auth = await fisAuthToken();
    const token = (await createRegistration(auth)).body.token as string;
    const answer = await deleteRegistration(token, auth);
    expect(answer).toEqual({ status: 200, contentType: 'application/json; charset=UTF-8', body: {} });
    expect(server.messaging.at(-1)?.message).toEqual({ api: 'registrations', method: 'DELETE', path: `/v1/projects/${PROJECT}/registrations/${token}` });
    expect(server.unmatched).toEqual([]);
  });

  test('the referrer-blocked key gets production\'s 403 and body', async () => {
    const answer = await createInstallation(REFERRER_BLOCKED_KEY);
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({
      error: { code: 403, status: 'PERMISSION_DENIED', message: 'Requests from referer http://localhost:4873/ are blocked.', details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }, { locale: 'en-US' }] },
    });
    expect(server.unmatched).toEqual([]);
  });

  test('an unrecorded path is answered 400 pyric_replay_no_recording and listed in unmatched', async () => {
    const fid = 'cReplayFid0123456789ab';
    const answer = await send(`${INSTALLATIONS}/${fid}/authTokens:generate`, { method: 'POST', headers: { ...JSON_HEADERS, 'x-goog-api-key': API_KEY }, body: '{}' });
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ error: { code: 400, status: 'INVALID_ARGUMENT' } });
    expect(String((answer.body.error as { message: string }).message)).toStartWith(`${NO_RECORDING}:`);
    expect(server.unmatched).toEqual([{ rpc: 'http', as: null, request: { service: 'messaging', api: 'installations', method: 'POST', path: `/v1/projects/${PROJECT}/installations/${fid}/authTokens:generate` } }]);
  });

  test('a registration under a FIS token this server never issued, or a delete of a token it never issued, fails closed', async () => {
    const stranger = await createRegistration('a-token-the-replay-never-issued');
    expect(stranger.status).toBe(400);
    const auth = await fisAuthToken();
    const unknown = await deleteRegistration('never-issued', auth);
    expect(unknown.status).toBe(400);
    expect(server.unmatched.map((entry) => (entry.request as { method: string }).method)).toEqual(['POST', 'DELETE']);
  });

  test('another project\'s path fails closed', async () => {
    const answer = await send('https://firebaseinstallations.googleapis.com/v1/projects/another-project/installations', { method: 'POST', headers: { ...JSON_HEADERS, 'x-goog-api-key': API_KEY }, body: '{}' });
    expect(answer.status).toBe(400);
    expect(server.unmatched).toHaveLength(1);
  });

  test('a page\'s CORS preflight is allowed the methods and headers both SDKs send', async () => {
    const headers = 'content-type, x-goog-api-key, x-goog-firebase-installations-auth, authorization, x-firebase-client';
    const response = await fetch(`${server.origin}/fcmregistrations.googleapis.com/v1/projects/${PROJECT}/registrations/x`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'DELETE', 'access-control-request-headers': headers },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(response.headers.get('access-control-allow-methods')).toContain('DELETE');
    for (const name of headers.split(', ')) expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(name);
  });
});

describe('the messaging exchange shape', () => {
  /** The fixture with only its exchange at `index`, answering `body`. */
  function withAnswer(body: Record<string, unknown>, index = 0): Recording {
    const recording = readRecording(MINIMAL);
    const exchange = recording.exchanges[index]!;
    return { ...recording, exchanges: [{ ...exchange, response: { status: 200, body } } as Recording['exchanges'][number]] };
  }

  test('a literal FID, FIS token or registration token in an answer is refused', () => {
    expect(() => assertShapesOnly(withAnswer({ fid: 'cReal' }))).toThrow('must be the placeholder {"$":"fid"}');
    expect(() => assertShapesOnly(withAnswer({ authToken: { token: 'real' } }))).toThrow('must be the placeholder {"$":"fisAuthToken"}');
    expect(() => assertShapesOnly(withAnswer({ token: 'real' }, 1))).toThrow('must be the placeholder {"$":"fcmToken"}');
  });

  test('a path outside the recording\'s project is refused', () => {
    const recording = readRecording(MINIMAL);
    const [first] = recording.exchanges;
    const moved = { ...first!, request: { ...(first as { request: object }).request, path: '/v1/projects/elsewhere/installations' } };
    expect(() => assertShapesOnly({ ...recording, exchanges: [moved as Recording['exchanges'][number]] })).toThrow('outside project demo-replay-messaging');
  });
});
