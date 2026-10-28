/**
 * Which hosts the network guard checks on one connection (#1442).
 *
 * The socket backstop used to read only `host` (or `hostname`) from a connect
 * call, and the catalog compared that text as written. These tests pin the
 * rest: every spelling of the metadata IP, the TLS `servername` of a socket
 * that tunnels through a proxy, the target of a `CONNECT` request, and the
 * host in an absolute-form request path sent to a forward proxy. They drive
 * `installNetGuard` with stand-in `net` and `tls` modules, so no socket opens.
 */
import { describe, expect, it } from 'bun:test';
import {
  GUARD_BLOCKED_CODE,
  evaluateEgress,
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

/** Installs a block-mode guard over stand-in seams, and returns them. */
function guardedSeams(): Seams {
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
    env: { PYRIC_SANDBOX: '1', PYRIC_GUARD: 'block' },
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
function requestOutcome(request: { method: string; path: string }): string {
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

describe('metadata IP spellings through the socket backstop', () => {
  const spellings = [
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

  it('the allowlist cannot permit a respelled metadata IP', () => {
    const verdict = evaluateEgress('0xa9fea9fe', { mode: 'block', allow: ['2852039166'] });
    expect(verdict?.permitted).toBe(false);
    expect(verdict?.alwaysBlock).toBe(true);
    expect(verdict?.host).toBe('169.254.169.254');
  });
});

describe('hosts a tunnelled connection names', () => {
  it('tls.connect refuses a servername on a catalog host over an existing socket', () => {
    const { tls } = guardedSeams();
    expect(outcome(() => tls.connect({ socket: {}, servername: 'firestore.googleapis.com' }))).toBe(
      GUARD_BLOCKED_CODE,
    );
  });

  it('tls.connect refuses a servername on a catalog host when the peer is local', () => {
    const { tls } = guardedSeams();
    const options = { host: '127.0.0.1', port: 8443, servername: 'firestore.googleapis.com' };
    expect(outcome(() => tls.connect(options))).toBe(GUARD_BLOCKED_CODE);
  });

  it('fails a CONNECT request whose target is a catalog host', () => {
    expect(requestOutcome({ method: 'CONNECT', path: 'firestore.googleapis.com:443' })).toBe(GUARD_BLOCKED_CODE);
  });

  it('fails a CONNECT request whose target is a respelled metadata IP', () => {
    expect(requestOutcome({ method: 'CONNECT', path: '[::ffff:a9fe:a9fe]:80' })).toBe(GUARD_BLOCKED_CODE);
    expect(requestOutcome({ method: 'connect', path: '2852039166:80' })).toBe(GUARD_BLOCKED_CODE);
    expect(requestOutcome({ method: 'CONNECT', path: '[::ffff:a9fe:a9fe%25lo]:80' })).toBe(GUARD_BLOCKED_CODE);
  });

  it('fails an absolute-form request to a catalog host sent to a forward proxy', () => {
    expect(requestOutcome({ method: 'GET', path: 'http://firestore.googleapis.com/v1/x' })).toBe(GUARD_BLOCKED_CODE);
  });

  it('permits an ordinary request path, a CONNECT outside the catalog, and a local servername', () => {
    expect(requestOutcome({ method: 'GET', path: '/v1/firestore.googleapis.com' })).toBe('permitted');
    expect(requestOutcome({ method: 'CONNECT', path: 'example.com:443' })).toBe('permitted');
    const { tls } = guardedSeams();
    expect(outcome(() => tls.connect({ host: '127.0.0.1', port: 8443, servername: 'localhost' }))).toBe('permitted');
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
