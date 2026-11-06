/**
 * Which hosts the network guard checks on one connection (#1442), under the
 * default mode, which refuses token sources (ADR 0022).
 *
 * The socket backstop used to read only `host` (or `hostname`) from a connect
 * call, and compared that text as written. These tests pin the rest: every
 * spelling of the metadata server, the TLS `servername` of a socket that
 * tunnels through a proxy, the target of a `CONNECT` request, the host in an
 * absolute-form request path sent to a forward proxy, and the token path on
 * `www.googleapis.com`. They drive `installNetGuard` with stand-in `net` and
 * `tls` modules, so no socket opens.
 */
import { describe, expect, it } from 'bun:test';
import {
  GUARD_BLOCKED_CODE,
  installNetGuard,
  parseAllowHosts,
} from '../../src/register/net-guard.js';

type ConnectFn = (...args: unknown[]) => unknown;

interface Seams {
  net: { connect: ConnectFn; createConnection: ConnectFn };
  tls: { connect: ConnectFn };
  socket: { connect: ConnectFn };
  agent: { createConnection: ConnectFn };
  request: { onSocket: (this: unknown, socket: unknown, error?: unknown) => unknown };
  /** The error each `onSocket` call passed on to Node, `undefined` for none. */
  onSocketErrors: unknown[];
}

/** Installs a guard under the default mode over stand-in seams, and returns them. */
function guardedSeams(env: Record<string, string> = {}): Seams {
  const passThrough: ConnectFn = () => ({});
  const onSocketErrors: unknown[] = [];
  const seams: Seams = {
    net: { connect: passThrough, createConnection: passThrough },
    tls: { connect: passThrough },
    socket: { connect: passThrough },
    agent: { createConnection: passThrough },
    request: { onSocket: (_socket, error) => onSocketErrors.push(error) },
    onSocketErrors,
  };
  const guard = installNetGuard({
    scope: {},
    env: { PYRIC_SANDBOX: '1', ...env },
    write: () => {},
    net: seams.net,
    tls: seams.tls,
    agentPrototypes: [seams.agent],
    socketPrototypes: [seams.socket],
    requestPrototypes: [seams.request],
  });
  guard?.stop();
  return seams;
}

/** The code of the error a request's `onSocket` handed Node, or `permitted`. */
function requestOutcome(request: { method: string; path: string; host?: string }): string {
  const seams = guardedSeams();
  seams.request.onSocket.call(request, {});
  const error = seams.onSocketErrors[0];
  if (error === undefined) return 'permitted';
  return (error as { code?: string }).code ?? String(error);
}

/** The guard's error code when `connect` is refused, or `permitted`. */
function outcome(connect: () => unknown): string {
  try {
    connect();
    return 'permitted';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe('metadata server spellings through the socket backstop', () => {
  const spellings = [
    '169.254.169.254',
    'metadata.google.internal',
    'METADATA.google.internal.',
    'metadata',
    'fd20:ce::254',
    'fd20:00ce:0000:0000:0000:0000:0000:0254',
    '[fd20:ce::254]',
    '2852039166',
    '0xa9fea9fe',
    '169.254.43518',
    '0251.0376.0251.0376',
    '::ffff:169.254.169.254',
    '::ffff:a9fe:a9fe',
    '::ffff:a9fe:a9fe%lo',
    '::ffff:169.254.169.254%25eth0',
  ];

  for (const host of spellings) {
    it(`net.connect refuses host ${host}`, () => {
      const { net } = guardedSeams();
      expect(outcome(() => net.connect({ host, port: 80 }))).toBe(GUARD_BLOCKED_CODE);
    });

    it(`Socket.prototype.connect refuses (80, ${host})`, () => {
      const { socket } = guardedSeams();
      expect(outcome(() => socket.connect(80, host))).toBe(GUARD_BLOCKED_CODE);
    });
  }

  it('PYRIC_GUARD_ALLOW cannot permit a respelled metadata IP', () => {
    const { net } = guardedSeams({ PYRIC_GUARD_ALLOW: '2852039166,169.254.169.254' });
    expect(outcome(() => net.connect({ host: '0xa9fea9fe', port: 80 }))).toBe(GUARD_BLOCKED_CODE);
  });

  it('PYRIC_GUARD=warn refuses the metadata server too', () => {
    const { net } = guardedSeams({ PYRIC_GUARD: 'warn' });
    expect(outcome(() => net.connect({ host: '2852039166', port: 80 }))).toBe(GUARD_BLOCKED_CODE);
  });
});

describe('hosts a tunnelled connection names', () => {
  it('tls.connect refuses a servername on a token host over an existing socket', () => {
    const { tls } = guardedSeams();
    expect(outcome(() => tls.connect({ socket: {}, servername: 'oauth2.googleapis.com' }))).toBe(
      GUARD_BLOCKED_CODE,
    );
  });

  it('tls.connect refuses a servername on a token host when the peer is local', () => {
    const { tls } = guardedSeams();
    const options = { host: '127.0.0.1', port: 8443, servername: 'sts.googleapis.com' };
    expect(outcome(() => tls.connect(options))).toBe(GUARD_BLOCKED_CODE);
  });

  it('fails a CONNECT request whose target is a token host', () => {
    expect(requestOutcome({ method: 'CONNECT', path: 'iamcredentials.googleapis.com:443' })).toBe(GUARD_BLOCKED_CODE);
  });

  it('fails a CONNECT request whose target is a respelled metadata IP', () => {
    expect(requestOutcome({ method: 'CONNECT', path: '[::ffff:a9fe:a9fe]:80' })).toBe(GUARD_BLOCKED_CODE);
    expect(requestOutcome({ method: 'connect', path: '2852039166:80' })).toBe(GUARD_BLOCKED_CODE);
    expect(requestOutcome({ method: 'CONNECT', path: '[::ffff:a9fe:a9fe%25lo]:80' })).toBe(GUARD_BLOCKED_CODE);
  });

  it('fails an absolute-form request to a token host sent to a forward proxy', () => {
    expect(requestOutcome({ method: 'POST', path: 'http://oauth2.googleapis.com/token' })).toBe(GUARD_BLOCKED_CODE);
  });

  it('fails an absolute-form request to the token path on www.googleapis.com', () => {
    const path = 'http://www.googleapis.com/oauth2/v4/token';
    expect(requestOutcome({ method: 'POST', path })).toBe(GUARD_BLOCKED_CODE);
  });

  it('permits a Firebase data host through a tunnel: the guard refuses only token sources', () => {
    expect(requestOutcome({ method: 'CONNECT', path: 'firestore.googleapis.com:443' })).toBe('permitted');
    expect(requestOutcome({ method: 'GET', path: 'http://firestore.googleapis.com/v1/x' })).toBe('permitted');
    const { tls } = guardedSeams();
    expect(outcome(() => tls.connect({ socket: {}, servername: 'firestore.googleapis.com' }))).toBe('permitted');
  });

  it('permits an ordinary request path, a CONNECT to another host, and a local servername', () => {
    expect(requestOutcome({ method: 'GET', path: '/v1/oauth2.googleapis.com' })).toBe('permitted');
    expect(requestOutcome({ method: 'CONNECT', path: 'example.com:443' })).toBe('permitted');
    const { tls } = guardedSeams();
    expect(outcome(() => tls.connect({ host: '127.0.0.1', port: 8443, servername: 'localhost' }))).toBe('permitted');
  });
});

describe('a request\'s own path on www.googleapis.com (ruling 6)', () => {
  for (const path of ['/oauth2/v4/token', '/oauth2/v3/token?x=1', '//OAuth2/v4/%74oken']) {
    it(`fails a request to ${path}`, () => {
      expect(requestOutcome({ method: 'POST', host: 'www.googleapis.com', path })).toBe(GUARD_BLOCKED_CODE);
    });
  }

  for (const path of ['/oauth2/v1/certs', '/oauth2/v3/certs', '/drive/v3/files', '/oauth2/v4/tokeninfo']) {
    it(`permits a request to ${path}`, () => {
      expect(requestOutcome({ method: 'GET', host: 'www.googleapis.com', path })).toBe('permitted');
    });
  }

  it('lets the socket to www.googleapis.com through: only the path tells a token request apart', () => {
    const { tls } = guardedSeams();
    expect(outcome(() => tls.connect({ host: 'www.googleapis.com', port: 443 }))).toBe('permitted');
  });
});

describe('ports on IPv6 hosts', () => {
  it('keeps the last group of a bare IPv6 address that ends in digits', () => {
    expect(parseAllowHosts('2001:db8::1')).toEqual(['2001:db8::1']);
    expect(parseAllowHosts('::1')).toEqual(['::1']);
  });

  it('strips the port from a bracketed IPv6 address and from a name', () => {
    expect(parseAllowHosts('[2001:db8::1]:443')).toEqual(['2001:db8::1']);
    expect(parseAllowHosts('example.com:443')).toEqual(['example.com']);
  });
});
