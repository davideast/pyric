/**
 * The network report in a live process (`live-net-guard.ts`): it lets every
 * call out, and lists each Google and Firebase host that no live row
 * observes, once, on a line and in its list. Stand-ins take the place of the
 * hooked Node seams, so nothing leaves this process.
 */
import { describe, expect, test } from 'bun:test';
import { installLiveNetGuard } from '../../src/register/live-net-guard.js';

const UNDICI_SLOT = Symbol.for('undici.globalDispatcher.1');

/** The report on stand-in seams, and a record of what each seam sent on. */
function reportSeams(adminRows: boolean) {
  const sent: string[] = [];
  const lines: string[] = [];
  const scope: Record<symbol, unknown> = { [UNDICI_SLOT]: { dispatch: (opts: { origin: string }) => sent.push(`fetch ${new URL(opts.origin).hostname}`) } };
  const tls = { connect: (options: { host: string }) => sent.push(`socket ${options.host}`) };
  const net = { connect: () => ({}), createConnection: () => ({}) };
  const requestPrototype = {
    onSocket(this: { host: string }, _socket: unknown, error?: unknown) {
      sent.push(error === undefined || error === null ? `request ${this.host}` : `request ${this.host} refused`);
    },
  };
  const report = installLiveNetGuard({
    adminRows,
    scope,
    env: {},
    write: (line) => lines.push(line),
    net,
    tls,
    agentPrototypes: [],
    socketPrototypes: [],
    requestPrototypes: [requestPrototype],
  });
  const fetchTo = (url: string) => {
    const { origin, pathname } = new URL(url);
    (scope[UNDICI_SLOT] as { dispatch(opts: unknown, handler: unknown): unknown }).dispatch({ origin, path: pathname }, {});
  };
  const connect = (host: string) => tls.connect({ host });
  const request = (host: string, path: string) => {
    const pending = Object.assign(Object.create(requestPrototype) as { onSocket(socket: unknown): unknown }, { host, path, method: 'POST' });
    pending.onSocket({});
  };
  return { report, sent, lines, fetchTo, connect, request, stop: () => report.stop() };
}

describe('the live network report', () => {
  test('lets every call out, and lists each Google host no live row observes once, in first-call order', () => {
    const seams = reportSeams(false);
    try {
      seams.fetchTo('https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/m:generateContent');
      seams.fetchTo('https://cloudtrace.googleapis.com/v2/projects/demo/traces:batchWrite');
      seams.fetchTo('https://firebaseappcheck.googleapis.com/v1/jwks');
      seams.fetchTo('https://us-central1-aiplatform.googleapis.com/v1/projects/demo/locations/us-central1/publishers/google/models/m:generateContent');
      seams.connect('oauth2.googleapis.com');
      seams.request('www.googleapis.com', '/oauth2/v4/token');
      seams.connect('firestore.googleapis.com');
      seams.fetchTo('https://identitytoolkit.googleapis.com/v1/accounts:lookup');
      seams.connect('demo-default-rtdb.firebaseio.com');
      seams.fetchTo('https://example.com/');
      seams.connect('169.254.169.254');
      expect(seams.sent).toEqual([
        'fetch us-central1-aiplatform.googleapis.com',
        'fetch cloudtrace.googleapis.com',
        'fetch firebaseappcheck.googleapis.com',
        'fetch us-central1-aiplatform.googleapis.com',
        'socket oauth2.googleapis.com',
        'request www.googleapis.com',
        'socket firestore.googleapis.com',
        'fetch identitytoolkit.googleapis.com',
        'socket demo-default-rtdb.firebaseio.com',
        'fetch example.com',
        'socket 169.254.169.254',
      ]);
      expect(seams.report.unobserved()).toEqual([
        'us-central1-aiplatform.googleapis.com',
        'cloudtrace.googleapis.com',
        'firebaseappcheck.googleapis.com',
        'oauth2.googleapis.com',
        'www.googleapis.com',
        '169.254.169.254',
      ]);
      expect(seams.lines).toHaveLength(6);
      expect(seams.lines[3]).toStartWith('@pyric/live/register: unobserved call to oauth2.googleapis.com (');
      expect(seams.lines.join('')).not.toContain('PYRIC_GUARD_BLOCKED');
    } finally {
      seams.stop();
    }
  });

  test("reads an http.request to a live row host as unobserved, unless an Admin row's SDK sends it", () => {
    const clientOnly = reportSeams(false);
    clientOnly.request('firestore.googleapis.com', '/v1/projects/demo/databases/(default)/documents/rooms/lobby');
    clientOnly.request('firebasestorage.googleapis.com', '/v0/b/demo.appspot.com/o');
    const fromClientOnly = clientOnly.report.unobserved();
    clientOnly.stop();
    const withAdmin = reportSeams(true);
    withAdmin.request('firestore.googleapis.com', '/v1/projects/demo/databases/(default)/documents/rooms/lobby');
    withAdmin.request('identitytoolkit.googleapis.com', '/v1/projects/demo/accounts:lookup');
    withAdmin.request('storage.googleapis.com', '/storage/v1/b/demo.appspot.com/o');
    withAdmin.request('content-firebaseappcheck.googleapis.com', '/v1/projects/demo/apps/1:1:web:1:exchangeDebugToken');
    const fromAdmin = withAdmin.report.unobserved();
    withAdmin.stop();
    expect({ fromClientOnly, fromAdmin }).toEqual({
      fromClientOnly: ['firestore.googleapis.com', 'firebasestorage.googleapis.com'],
      fromAdmin: ['content-firebaseappcheck.googleapis.com'],
    });
  });

  test("reads Cloud Storage's JSON API as observed only with the Admin rows on", () => {
    const clientOnly = reportSeams(false);
    clientOnly.connect('storage.googleapis.com');
    const fromClientOnly = clientOnly.report.unobserved();
    clientOnly.stop();
    const withAdmin = reportSeams(true);
    withAdmin.connect('storage.googleapis.com');
    const fromAdmin = withAdmin.report.unobserved();
    withAdmin.stop();
    expect({ fromClientOnly, fromAdmin }).toEqual({ fromClientOnly: ['storage.googleapis.com'], fromAdmin: [] });
  });
});
