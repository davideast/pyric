/**
 * The runtime network guard (`src/register/net-guard.ts`): the credential
 * choke point (ADR-0022, decision 2).
 *
 * Once `PYRIC_SANDBOX` is set, a pyric-launched Node process can't get a
 * server-side Google access token: every request to a token source
 * (`google-token-endpoints.ts`) fails with `PYRIC_GUARD_BLOCKED`, whatever
 * `PYRIC_GUARD` says except `off`. Every other host passes without a report,
 * Firebase data hosts included.
 *
 * Test shape, and why:
 *  - The interception seams are unit-tested against MOCK dispatchers and
 *    stand-in `net`/`tls` modules, with the same token list the production
 *    path uses.
 *  - The dispatcher hook itself only works on a real Node undici (Bun serves
 *    `fetch` natively and never reads
 *    `Symbol.for('undici.globalDispatcher.1')`), so the end-to-end facts are
 *    proven in `node --import` subprocesses: installing the guard does not
 *    break an ordinary child, a token request fails with the GUARD's cause
 *    rather than DNS's in every mode but `off`, a plain `http.request` is
 *    refused before it connects even when `node:http` loaded first, and a real
 *    socket is refused however the caller reached `connect`. Those children
 *    replace the resolver, so a connection the guard lets through stops there
 *    instead of reaching DNS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GUARD_BLOCKED_CODE,
  NET_GUARD_GLOBAL,
  evaluateEgress,
  installNetGuard,
  permitGuardHost,
  parseAllowHosts,
  parseGuardMode,
  wrapDispatcher,
  type EgressRefusal,
} from '../../src/register/net-guard.js';
import { tokenEndpoints } from '../../src/google-token-endpoints.js';

// ─── mode + allowlist parsing ───────────────────────────────────────────────

describe('parseGuardMode', () => {
  it('is block, the choke point, when unset or empty', () => {
    expect(parseGuardMode(undefined)).toBe('block');
    expect(parseGuardMode('')).toBe('block');
    expect(parseGuardMode('   ')).toBe('block');
  });

  it('is block for warn too: warn no longer lets a token request through', () => {
    expect(parseGuardMode('warn')).toBe('block');
    expect(parseGuardMode(' WARN ')).toBe('block');
    expect(parseGuardMode('block')).toBe('block');
  });

  it('is off only when named, case/space-insensitively', () => {
    expect(parseGuardMode('off')).toBe('off');
    expect(parseGuardMode(' Off ')).toBe('off');
  });

  it('is block on an unknown value', () => {
    expect(parseGuardMode('nope')).toBe('block');
    expect(parseGuardMode('true')).toBe('block');
  });
});

describe('parseAllowHosts', () => {
  it('is empty when unset', () => {
    expect(parseAllowHosts(undefined)).toEqual([]);
    expect(parseAllowHosts('')).toEqual([]);
  });

  it('splits on commas and whitespace, lowercases, drops empties', () => {
    expect(parseAllowHosts('A.example.com, b.example.com  c.example.com,,')).toEqual([
      'a.example.com',
      'b.example.com',
      'c.example.com',
    ]);
  });

  it('accepts full URLs (AI engine baseUrls) and keeps only the hostname', () => {
    expect(parseAllowHosts('https://api.openai.com/v1,http://127.0.0.1:11434')).toEqual([
      'api.openai.com',
      '127.0.0.1',
    ]);
  });
});

// ─── the verdict: token sources only ────────────────────────────────────────

const on = { mode: 'block' as const };

describe('evaluateEgress', () => {
  it('lets every host that is not a token source through, Firebase data hosts included', () => {
    for (const host of [
      '127.0.0.1',
      'localhost',
      'example.com',
      'firestore.googleapis.com',
      'identitytoolkit.googleapis.com',
      'securetoken.googleapis.com',
      'us-central1-demo.cloudfunctions.net',
      'fonts.googleapis.com',
      'my-api-abc123-uc.a.run.app',
      'firebasevertexai.googleapis.com',
      'firebaserules.googleapis.com',
    ]) {
      expect({ host, refusal: evaluateEgress(host, on) }).toEqual({ host, refusal: null });
    }
  });

  it('refuses a token host, naming the host and the service', () => {
    expect(evaluateEgress('oauth2.googleapis.com', on)).toEqual({
      host: 'oauth2.googleapis.com',
      endpoint: 'oauth2.googleapis.com',
      service: 'Google OAuth 2.0 token endpoint',
    });
    expect(evaluateEgress('sts.googleapis.com', on)?.service).toBe('Google Security Token Service');
    expect(evaluateEgress('iamcredentials.googleapis.com', on)?.service).toBe('IAM Service Account Credentials');
  });

  it('refuses the metadata server, by any name and address form', () => {
    for (const host of ['169.254.169.254', '0xa9fea9fe', 'metadata.google.internal.', 'metadata', '[fd20:ce::254]:80']) {
      expect({ host, refused: evaluateEgress(host, on) !== null }).toEqual({ host, refused: true });
    }
  });

  it('refuses www.googleapis.com only on a token path', () => {
    expect(evaluateEgress({ host: 'www.googleapis.com', path: '/oauth2/v4/token' }, on)?.host).toBe('www.googleapis.com');
    expect(evaluateEgress({ host: 'www.googleapis.com', path: '/oauth2/v3/certs' }, on)).toBeNull();
    expect(evaluateEgress('www.googleapis.com', on)).toBeNull();
  });

  it('reads a host and path out of an absolute-form URL and a host:port', () => {
    expect(evaluateEgress('https://www.googleapis.com/oauth2/v4/token', on)).not.toBeNull();
    expect(evaluateEgress('oauth2.googleapis.com:443', on)).not.toBeNull();
    expect(evaluateEgress('https://www.googleapis.com/oauth2/v1/certs', on)).toBeNull();
  });

  it('is silent for every host when the guard is off', () => {
    const off = { mode: 'off' as const };
    expect(evaluateEgress('oauth2.googleapis.com', off)).toBeNull();
    expect(evaluateEgress('169.254.169.254', off)).toBeNull();
  });

  it('uses the token list it is given, such as one read from GCE_METADATA_HOST', () => {
    const endpoints = tokenEndpoints({ env: { GCE_METADATA_HOST: 'metadata.corp.example' }, readFile: () => '' });
    expect(evaluateEgress('metadata.corp.example', { mode: 'block', endpoints })).not.toBeNull();
    expect(evaluateEgress('metadata.corp.example', on)).toBeNull();
  });
});

// ─── the undici dispatcher seam ─────────────────────────────────────────────

interface MockCall {
  opts: unknown;
  handler: unknown;
}

function mockDispatcher(): { dispatch: (o: unknown, h: unknown) => boolean; calls: MockCall[]; closed: boolean } {
  const calls: MockCall[] = [];
  const d = {
    calls,
    closed: false,
    dispatch(opts: unknown, handler: unknown): boolean {
      calls.push({ opts, handler });
      return true;
    },
    close(): void {
      d.closed = true;
    },
  };
  return d;
}

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('wrapDispatcher', () => {
  it('passes every other origin straight through, silently, Firebase data hosts included', () => {
    const real = mockDispatcher();
    const log = collector();
    const handler = { onData() {} };
    const wrapped = wrapDispatcher(real, { mode: 'block', write: log.write });
    expect(wrapped.dispatch({ origin: 'http://127.0.0.1:5000', path: '/x' }, handler)).toBe(true);
    expect(wrapped.dispatch({ origin: 'https://firestore.googleapis.com', path: '/v1/x' }, handler)).toBe(true);
    expect(wrapped.dispatch({ origin: 'https://fonts.googleapis.com', path: '/css2' }, handler)).toBe(true);
    expect(wrapped.dispatch({ origin: 'https://www.googleapis.com', path: '/oauth2/v3/certs' }, handler)).toBe(true);
    expect(real.calls).toHaveLength(4);
    expect(log.lines).toEqual([]);
  });

  it('passes the handler and opts through by IDENTITY (v6/v7 cross-version handoff)', () => {
    const real = mockDispatcher();
    const handler = Object.freeze({ onConnect() {}, onHeaders() {} });
    const opts = { origin: new URL('https://firestore.googleapis.com'), path: '/v1/x' };
    const wrapped = wrapDispatcher(real, { mode: 'block', write: collector().write });
    wrapped.dispatch(opts, handler);
    expect(real.calls[0]!.handler).toBe(handler);
    expect(real.calls[0]!.opts).toBe(opts);
  });

  it('refuses a token host: never reaches the real dispatcher and throws the guard error', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, { mode: 'block', write: log.write, context: 'probe.mjs' });
    const thrown = thrownBy(() => wrapped.dispatch({ origin: 'https://oauth2.googleapis.com', path: '/token' }, {}));
    expect(real.calls).toHaveLength(0);
    expect((thrown as { code?: string }).code).toBe(GUARD_BLOCKED_CODE);
    expect((thrown as Error).message).toContain('oauth2.googleapis.com');
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('net-guard BLOCK oauth2.googleapis.com (Google OAuth 2.0 token endpoint) via fetch from probe.mjs');
    expect(log.lines[0]!.endsWith('\n')).toBe(true);
  });

  it('refuses the gtoken exchange path on www.googleapis.com, reading opts.path', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, { mode: 'block', write: log.write });
    const thrown = thrownBy(() => wrapped.dispatch({ origin: 'https://www.googleapis.com', path: '/oauth2/v4/token' }, {}));
    expect((thrown as { code?: string }).code).toBe(GUARD_BLOCKED_CODE);
    expect(real.calls).toHaveLength(0);
    // The request path can carry ids, so it is never logged.
    expect(log.lines[0]).not.toContain('/oauth2/v4/token');
  });

  it('names the two ways out, and no allowlist, in the log line and the error alike', () => {
    const log = collector();
    const wrapped = wrapDispatcher(mockDispatcher(), { mode: 'block', write: log.write });
    const thrown = thrownBy(() => wrapped.dispatch({ origin: 'http://169.254.169.254', path: '/x' }, {}));
    for (const text of [log.lines[0]!, (thrown as Error).message]) {
      expect(text).toContain('outside pyric sandbox');
      expect(text).toContain('PYRIC_GUARD=off');
      expect(text).not.toContain('PYRIC_GUARD_ALLOW');
      expect(text).not.toContain('PYRIC_GUARD=warn');
    }
    expect(log.lines[0]).toContain('TypeError: fetch failed');
  });

  it('logs each host only once, since a dev server retries constantly', () => {
    const log = collector();
    const wrapped = wrapDispatcher(mockDispatcher(), { mode: 'block', write: log.write });
    for (let i = 0; i < 5; i++) {
      thrownBy(() => wrapped.dispatch({ origin: 'https://oauth2.googleapis.com', path: `/token?${i}` }, {}));
    }
    thrownBy(() => wrapped.dispatch({ origin: 'https://sts.googleapis.com', path: '/v1/token' }, {}));
    expect(log.lines).toHaveLength(2);
    expect(log.lines[1]).toContain('sts.googleapis.com');
  });

  it('forwards every other dispatcher member to the real instance', () => {
    const real = mockDispatcher();
    const wrapped = wrapDispatcher(real, { mode: 'block', write: collector().write }) as unknown as {
      close: () => void;
      calls: MockCall[];
    };
    wrapped.close();
    expect(real.closed).toBe(true);
    expect(wrapped.calls).toBe(real.calls);
  });

  it('tolerates a dispatch with no usable origin', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, { mode: 'block', write: log.write });
    expect(wrapped.dispatch({ path: '/x' }, {})).toBe(true);
    expect(wrapped.dispatch({ origin: 'not a url' }, {})).toBe(true);
    expect(log.lines).toEqual([]);
  });
});

// ─── install: the notices, the scope handoff, the re-assert ─────────────────

/** A stand-in for `globalThis` so no test ever mutates the real one. */
function fakeScope(dispatcher: unknown): Record<symbol, unknown> {
  return { [Symbol.for('undici.globalDispatcher.1')]: dispatcher };
}

const UNDICI = Symbol.for('undici.globalDispatcher.1');

type Dispatch = (o: unknown, h: unknown) => unknown;

describe('installNetGuard', () => {
  const noNet = { connect: () => ({}), createConnection: () => ({}) };
  const noTls = { connect: () => ({}) };
  // The prototype seams default to Node's real built-ins. Every unit test hands
  // in stand-ins (or none) so the test process's own sockets stay unpatched.
  const noPrototypes = { agentPrototypes: [], socketPrototypes: [], requestPrototypes: [] };

  it('is inert and silent when PYRIC_SANDBOX is absent', () => {
    const real = mockDispatcher();
    const scope = fakeScope(real);
    const log = collector();
    const guard = installNetGuard({ scope, env: {}, write: log.write, net: noNet, tls: noTls, ...noPrototypes });
    expect(guard).toBeNull();
    expect(scope[UNDICI]).toBe(real);
    expect(log.lines).toEqual([]);
  });

  it('PYRIC_GUARD=off prints exactly one notice and installs nothing', () => {
    const real = mockDispatcher();
    const scope = fakeScope(real);
    const log = collector();
    const guard = installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1', PYRIC_GUARD: 'off' },
      write: log.write,
      net: noNet,
      tls: noTls,
      ...noPrototypes,
    });
    expect(guard).toBeNull();
    expect(scope[UNDICI]).toBe(real);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('net-guard disabled (PYRIC_GUARD=off)');
    // The off notice names what is given up, and what still holds.
    expect(log.lines[0]).toContain('169.254.169.254');
    expect(log.lines[0]).toContain('still stop');
  });

  for (const [label, env] of [
    ['unset', {}],
    ['block', { PYRIC_GUARD: 'block' }],
    ['unrecognized', { PYRIC_GUARD: 'loud' }],
  ] as const) {
    it(`PYRIC_GUARD ${label}: installs the choke point silently, and refuses a token host`, () => {
      const real = mockDispatcher();
      const scope = fakeScope(real);
      const log = collector();
      const guard = installNetGuard({
        scope,
        env: { PYRIC_SANDBOX: '1', ...env },
        write: log.write,
        net: noNet,
        tls: noTls,
        ...noPrototypes,
        argv: ['/usr/bin/node', '/app/node_modules/.bin/next'],
      });
      expect(guard?.mode).toBe('block');
      expect(scope[UNDICI]).not.toBe(real);
      expect(log.lines).toEqual([]);
      const dispatch = (scope[UNDICI] as { dispatch: Dispatch }).dispatch;
      dispatch({ origin: 'https://firestore.googleapis.com', path: '/v1' }, {});
      expect(real.calls).toHaveLength(1);
      expect(log.lines).toEqual([]);
      expect(thrownBy(() => dispatch({ origin: 'https://oauth2.googleapis.com', path: '/token' }, {}))).toMatchObject({
        code: GUARD_BLOCKED_CODE,
      });
      expect(real.calls).toHaveLength(1);
      expect(log.lines).toHaveLength(1);
      expect(log.lines[0]).toContain('from next');
    });
  }

  it('PYRIC_GUARD=warn refuses a token host too, and says so once at install', () => {
    const real = mockDispatcher();
    const scope = fakeScope(real);
    const log = collector();
    const guard = installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1', PYRIC_GUARD: 'warn' },
      write: log.write,
      net: noNet,
      tls: noTls,
      ...noPrototypes,
    });
    expect(guard?.mode).toBe('block');
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('PYRIC_GUARD=warn no longer lets token requests through');
    const dispatch = (scope[UNDICI] as { dispatch: Dispatch }).dispatch;
    expect(thrownBy(() => dispatch({ origin: 'http://metadata.google.internal', path: '/' }, {}))).toMatchObject({
      code: GUARD_BLOCKED_CODE,
    });
    expect(real.calls).toHaveLength(0);
  });

  it('PYRIC_GUARD_ALLOW cannot open a token host', () => {
    const real = mockDispatcher();
    const scope = fakeScope(real);
    const guard = installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1', PYRIC_GUARD_ALLOW: 'oauth2.googleapis.com,169.254.169.254' },
      write: collector().write,
      net: noNet,
      tls: noTls,
      ...noPrototypes,
    })!;
    guard.permit('https://sts.googleapis.com/v1/token');
    const dispatch = (scope[UNDICI] as { dispatch: Dispatch }).dispatch;
    for (const origin of ['https://oauth2.googleapis.com', 'http://169.254.169.254', 'https://sts.googleapis.com']) {
      expect({ origin, error: thrownBy(() => dispatch({ origin, path: '/' }, {})) }).toMatchObject({
        origin,
        error: { code: GUARD_BLOCKED_CODE },
      });
    }
    expect(real.calls).toHaveLength(0);
  });

  it('reads GCE_METADATA_HOST and the credentials file once, at install', () => {
    const real = mockDispatcher();
    const scope = fakeScope(real);
    const reads: string[] = [];
    installNetGuard({
      scope,
      env: {
        PYRIC_SANDBOX: '1',
        GCE_METADATA_HOST: 'metadata.corp.example:8080',
        GOOGLE_APPLICATION_CREDENTIALS: '/creds/external.json',
      },
      readFile: (path) => {
        reads.push(path);
        return JSON.stringify({ token_url: 'https://sts.corp.example/v1/token' });
      },
      write: collector().write,
      net: noNet,
      tls: noTls,
      ...noPrototypes,
    });
    const dispatch = (scope[UNDICI] as { dispatch: Dispatch }).dispatch;
    for (const origin of ['http://metadata.corp.example:8080', 'https://sts.corp.example']) {
      expect({ origin, error: thrownBy(() => dispatch({ origin, path: '/' }, {})) }).toMatchObject({
        origin,
        error: { code: GUARD_BLOCKED_CODE },
      });
    }
    expect(reads).toEqual(['/creds/external.json']);
  });

  it('re-asserts itself after another library calls setGlobalDispatcher', () => {
    const scope = fakeScope(mockDispatcher());
    const log = collector();
    const guard = installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1' },
      write: log.write,
      net: noNet,
      tls: noTls,
      ...noPrototypes,
    })!;
    const installed = scope[UNDICI];
    // Next (or anyone) overwrites us with a fresh agent.
    const usurper = mockDispatcher();
    scope[UNDICI] = usurper;
    guard.reassert();
    expect(scope[UNDICI]).not.toBe(usurper);
    expect(scope[UNDICI]).not.toBe(installed);
    // and the new wrapper still guards, delegating to the usurper
    const dispatch = (scope[UNDICI] as { dispatch: Dispatch }).dispatch;
    dispatch({ origin: 'https://firestore.googleapis.com', path: '/v1' }, {});
    expect(usurper.calls).toHaveLength(1);
    expect(thrownBy(() => dispatch({ origin: 'https://oauth2.googleapis.com', path: '/token' }, {}))).toMatchObject({
      code: GUARD_BLOCKED_CODE,
    });
    expect(usurper.calls).toHaveLength(1);
    // A reassert with nothing to do is a no-op.
    const current = scope[UNDICI];
    guard.reassert();
    expect(scope[UNDICI]).toBe(current);
  });

  it('wraps net/tls connect as the non-fetch backstop, refusing token hosts with the guard code', () => {
    const scope = fakeScope(mockDispatcher());
    const log = collector();
    const netCalls: unknown[][] = [];
    const net = {
      connect: (...args: unknown[]) => {
        netCalls.push(args);
        return { sock: true };
      },
      createConnection: (...args: unknown[]) => {
        netCalls.push(args);
        return { sock: true };
      },
    };
    const tlsCalls: unknown[][] = [];
    const tls = {
      connect: (...args: unknown[]) => {
        tlsCalls.push(args);
        return { tls: true };
      },
    };
    installNetGuard({ scope, env: { PYRIC_SANDBOX: '1' }, write: log.write, net, tls, ...noPrototypes });

    // untouched hosts → passthrough, a Firebase data host among them
    expect(net.connect({ host: '127.0.0.1', port: 5000 })).toEqual({ sock: true });
    expect(net.connect(443, 'firestore.googleapis.com')).toEqual({ sock: true });
    expect(tls.connect({ host: 'identitytoolkit.googleapis.com', port: 443 })).toEqual({ tls: true });
    expect(netCalls).toHaveLength(2);
    expect(tlsCalls).toHaveLength(1);

    // positional (port, host) form
    expect(() => net.connect(443, 'oauth2.googleapis.com')).toThrow(/oauth2\.googleapis\.com/);
    expect(netCalls).toHaveLength(2);

    // options form, through tls
    expect(thrownBy(() => tls.connect({ host: 'sts.googleapis.com', port: 443 }))).toMatchObject({
      code: GUARD_BLOCKED_CODE,
    });
    expect(tlsCalls).toHaveLength(1);

    // createConnection shares the policy
    expect(() => net.createConnection({ host: 'metadata.google.internal', port: 80 })).toThrow(/metadata\.google\.internal/);

    // an IPC path is not a host
    expect(net.connect('/tmp/some.sock')).toEqual({ sock: true });

    expect(log.lines.map((l) => l.split(' ')[3])).toEqual([
      'oauth2.googleapis.com',
      'sts.googleapis.com',
      'metadata.google.internal',
    ]);
    expect(log.lines[0]).toContain('via socket');
  });

  it('guards an Agent prototype that snapshotted createConnection before install', () => {
    const scope = fakeScope(mockDispatcher());
    const netCalls: unknown[][] = [];
    const realCreateConnection = (...args: unknown[]): unknown => {
      netCalls.push(args);
      return { sock: true };
    };
    const net = { connect: realCreateConnection, createConnection: realCreateConnection };
    // What `_http_agent` does at load time: copy the CURRENT
    // `net.createConnection` onto the Agent prototype. Patching `net` later
    // never reaches this copy, which is why the prototype is patched too.
    const httpAgentPrototype = { createConnection: net.createConnection };

    installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1' },
      write: collector().write,
      net,
      tls: { connect: () => ({}) },
      agentPrototypes: [httpAgentPrototype],
      socketPrototypes: [],
      requestPrototypes: [],
    });

    const createConnection = httpAgentPrototype.createConnection as (o: unknown) => unknown;
    expect(() => createConnection({ host: '169.254.169.254', port: 80 })).toThrow(/169\.254\.169\.254/);
    expect(netCalls).toHaveLength(0);
    expect(createConnection({ host: '127.0.0.1', port: 5000 })).toEqual({ sock: true });
    expect(netCalls).toHaveLength(1);
  });

  it('guards a Socket prototype, reading the host from every connect argument form', () => {
    const scope = fakeScope(mockDispatcher());
    const connectCalls: unknown[][] = [];
    const socketPrototype = {
      connect: (...args: unknown[]): unknown => {
        connectCalls.push(args);
        return { connected: true };
      },
    };

    installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1' },
      write: collector().write,
      net: noNet,
      tls: noTls,
      agentPrototypes: [],
      socketPrototypes: [socketPrototype],
      requestPrototypes: [],
    });
    const connect = socketPrototype.connect as (...args: unknown[]) => unknown;

    // `net.connect` and `net.createConnection` call the prototype with their
    // arguments already normalized into one `[options, callback]` array.
    expect(() => connect([{ port: 443, host: 'oauth2.googleapis.com' }, null])).toThrow(/oauth2\.googleapis\.com/);
    // `new net.Socket().connect(port, host)`
    expect(() => connect(443, 'iamcredentials.googleapis.com')).toThrow(/iamcredentials\.googleapis\.com/);
    // `tls.connect` passes an options object
    expect(() => connect({ host: 'metadata', port: 80 })).toThrow(/metadata/);
    expect(connectCalls).toHaveLength(0);

    // Loopback in each form, an IPC path, and a Firebase data host go straight
    // through with their arguments untouched.
    const normalizedLoopback = [{ port: 5000, host: '127.0.0.1' }, null];
    expect(connect(normalizedLoopback)).toEqual({ connected: true });
    expect(connectCalls[0]![0]).toBe(normalizedLoopback);
    expect(connect(5000, '127.0.0.1')).toEqual({ connected: true });
    expect(connect({ host: 'localhost', port: 5000 })).toEqual({ connected: true });
    expect(connect([{ path: '/tmp/pyric.sock' }, null])).toEqual({ connected: true });
    expect(connect({ host: 'firebaseio.com', port: 443 })).toEqual({ connected: true });
    expect(connectCalls).toHaveLength(5);
  });

  it('has no escalate: there is no warn mode left to escalate from', () => {
    const guard = installNetGuard({
      scope: fakeScope(mockDispatcher()),
      env: { PYRIC_SANDBOX: '1' },
      write: collector().write,
      net: noNet,
      tls: noTls,
      ...noPrototypes,
    });
    expect('escalate' in (guard ?? {})).toBe(false);
  });
});

describe('permitGuardHost', () => {
  it('reaches the guard the register published, whichever copy of the module calls it', () => {
    const permitted: string[] = [];
    const slot = globalThis as unknown as Record<symbol, unknown>;
    const prior = slot[NET_GUARD_GLOBAL];
    slot[NET_GUARD_GLOBAL] = { permit: (host: string) => permitted.push(host) };
    try {
      permitGuardHost('https://aiplatform.googleapis.com/v1');
    } finally {
      slot[NET_GUARD_GLOBAL] = prior;
    }
    expect(permitted).toEqual(['https://aiplatform.googleapis.com/v1']);
  });

  it('does nothing in a process with no guard', () => {
    const slot = globalThis as unknown as Record<symbol, unknown>;
    const prior = slot[NET_GUARD_GLOBAL];
    delete slot[NET_GUARD_GLOBAL];
    try {
      expect(() => permitGuardHost('https://aiplatform.googleapis.com/v1')).not.toThrow();
    } finally {
      slot[NET_GUARD_GLOBAL] = prior;
    }
  });
});

// ─── end to end, in a real node child ───────────────────────────────────────

const cliRoot = resolve(import.meta.dir, '../..');
const registerDist = join(cliRoot, 'dist/register/index.js');
const registerUrl = pathToFileURL(registerDist).href;

let fixtureDir: string;

function runNode(
  script: string,
  env: Record<string, string | undefined>,
  preloads: readonly string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const args: string[] = [];
  // A preload is `--import`ed BEFORE register, which is how a child ends up
  // with `node:http` already loaded when the guard installs.
  for (const preload of preloads) args.push('--import', pathToFileURL(join(fixtureDir, preload)).href);
  args.push('--import', registerUrl, script);
  const res = spawnSync('node', args, {
    cwd: fixtureDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: undefined,
      PYRIC_SANDBOX: undefined,
      PYRIC_GUARD: undefined,
      PYRIC_GUARD_ALLOW: undefined,
      GCE_METADATA_HOST: undefined,
      GCE_METADATA_IP: undefined,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      ...env,
    },
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** The preload that keeps every child off DNS: a host the guard lets through fails with FIXTURE_NO_DNS. */
const NO_DNS = 'preload-sockets.mjs';

describe('net-guard under `node --import @pyric/cli/register`', () => {
  beforeAll(() => {
    if (!existsSync(registerDist)) {
      throw new Error(`dist/register/index.js missing, run \`bun run build\` first (${registerDist})`);
    }
    fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-net-guard-'));
    writeFileSync(
      join(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'net-guard-fixture', type: 'module' }),
    );

    // A child that reports whether the register published its guard.
    writeFileSync(
      join(fixtureDir, 'published.mjs'),
      `const guard = globalThis[Symbol.for('pyric.netGuard')];
console.log(JSON.stringify({ mode: guard?.mode ?? null, permit: typeof guard?.permit }));
`,
    );

    // 1. An ordinary child: boot, talk to localhost over fetch, exit clean.
    writeFileSync(
      join(fixtureDir, 'local.mjs'),
      `import assert from 'node:assert';
import { createServer } from 'node:http';
const server = createServer((_q, s) => s.end('pong'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const res = await fetch('http://127.0.0.1:' + port + '/ping');
assert.strictEqual(await res.text(), 'pong');
// http.request goes through the net.connect backstop and must be untouched.
const { request } = await import('node:http');
const raw = await new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: '/raw' }, (r) => {
    let body = '';
    r.setEncoding('utf8');
    r.on('data', (c) => { body += c; });
    r.on('end', () => resolve(body));
  });
  req.on('error', reject);
  req.end();
});
assert.strictEqual(raw, 'pong');
await new Promise((r) => server.close(r));
console.log('LOCAL_OK');
`,
    );

    // 2. A plain `http.request` (no undici, no fetch) to the metadata IP.
    //    This is the egress that escaped the guard while the dispatcher was
    //    materialized first: `_http_agent` had already copied the unpatched
    //    `net.createConnection` onto `http.Agent.prototype`.
    writeFileSync(
      join(fixtureDir, 'metadata.mjs'),
      `import { request } from 'node:http';
const started = Date.now();
let err;
try {
  await new Promise((resolve, reject) => {
    const req = request(
      { host: '169.254.169.254', port: 80, path: '/computeMetadata/v1/', timeout: 4000 },
      (res) => { res.resume(); resolve(); },
    );
    req.on('error', reject);
    req.end();
  });
} catch (e) {
  err = e;
}
console.log(JSON.stringify({
  code: err?.code ?? null,
  message: err?.message ?? null,
  elapsed: Date.now() - started,
}));
`,
    );

    // 3. A preload that loads `node:http` BEFORE the register module runs, so
    //    the Agent prototype's snapshot is taken from the unpatched `net`.
    writeFileSync(join(fixtureDir, 'preload-http.mjs'), `import 'node:http';\n`);

    // 4. fetch and http.request to a token source and to hosts that pass. The
    //    outcome is the guard's code, or the fixture resolver's for a request
    //    the guard let through.
    writeFileSync(
      join(fixtureDir, 'fetches.mjs'),
      `import https from 'node:https';
async function viaFetch(url) {
  try {
    await fetch(url, { method: 'POST', body: 'grant_type=x' });
    return 'sent';
  } catch (e) {
    return e.cause?.code ?? e.code ?? e.message;
  }
}
function viaRequest(host, path) {
  return new Promise((resolve) => {
    try {
      const req = https.request({ host, path, method: 'POST' }, (res) => { res.resume(); resolve('sent'); });
      req.on('error', (e) => resolve(e.code ?? e.message));
      req.end('grant_type=x');
    } catch (e) {
      resolve(e.code ?? e.message);
    }
  });
}
console.log(JSON.stringify({
  oauth2: await viaFetch('https://oauth2.googleapis.com/token'),
  gtokenFetch: await viaFetch('https://www.googleapis.com/oauth2/v4/token'),
  gtokenRequest: await viaRequest('www.googleapis.com', '/oauth2/v4/token'),
  certs: await viaFetch('https://www.googleapis.com/oauth2/v3/certs'),
  firestore: await viaFetch('https://firestore.googleapis.com/v1/projects/x/databases/(default)/documents'),
  fonts: await viaFetch('https://fonts.googleapis.com/css2?family=Roboto'),
}));
`,
    );
    // 5. A preload that runs BEFORE register: it takes its own references to
    //    the connect functions, the way a library does at load time, and
    //    replaces the resolver so no remote hostname reaches DNS. A host the
    //    guard lets through fails at that resolver with FIXTURE_NO_DNS, which
    //    is distinguishable from the guard's own refusal.
    writeFileSync(
      join(fixtureDir, NO_DNS),
      `import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
globalThis.capturedConnect = {
  netConnect: net.connect,
  netCreateConnection: net.createConnection,
  tlsConnect: tls.connect,
};
const realLookup = dns.lookup;
dns.lookup = function (hostname, options, callback) {
  const isLocal = hostname === 'localhost' || net.isIP(hostname) !== 0;
  if (isLocal) return realLookup.call(this, hostname, options, callback);
  const done = typeof options === 'function' ? options : callback;
  process.nextTick(() =>
    done(Object.assign(new Error('fixture resolver: ' + hostname), { code: 'FIXTURE_NO_DNS' })),
  );
  return {};
};
`,
    );

    // 6. Real sockets: the captured references, a hand-built net.Socket, and
    //    a captured tls.connect against token hosts and a Firebase data host,
    //    then loopback TCP, a Unix socket, and a local /__pyric/* route.
    writeFileSync(
      join(fixtureDir, 'sockets.mjs'),
      `import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { netConnect, netCreateConnection, tlsConnect } = globalThis.capturedConnect;

// The first thing a connection attempt does: a synchronous refusal, a
// resolver failure, or a completed connect.
function attempt(open) {
  let socket;
  try {
    socket = open();
  } catch (e) {
    return Promise.resolve(e.code ?? e.message);
  }
  return new Promise((resolve) => {
    socket.once('error', (e) => resolve(e.code ?? e.message));
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
  });
}

function listen(server, ...args) {
  return new Promise((resolve) => server.listen(...args, () => resolve(server.address())));
}

const tcp = net.createServer((s) => s.end());
const { port: tcpPort } = await listen(tcp, 0, '127.0.0.1');
const ipcPath = join(mkdtempSync(join(tmpdir(), 'pyric-ipc-')), 'guard.sock');
const ipc = net.createServer((s) => s.end());
await listen(ipc, ipcPath);
const pyricHost = http.createServer((req, res) => res.end(req.url));
const { port: pyricPort } = await listen(pyricHost, 0);

const outcomes = {
  capturedNetConnect: await attempt(() => netConnect(443, 'oauth2.googleapis.com')),
  capturedCreateConnection: await attempt(() =>
    netCreateConnection({ host: 'metadata.google.internal', port: 80 }),
  ),
  socketConnect: await attempt(() => new net.Socket().connect(443, 'iamcredentials.googleapis.com')),
  capturedTlsConnect: await attempt(() => tlsConnect({ host: 'sts.googleapis.com', port: 443 })),
  firestoreSocket: await attempt(() => new net.Socket().connect(443, 'firestore.googleapis.com')),
  loopbackCaptured: await attempt(() => netConnect(tcpPort, '127.0.0.1')),
  loopbackSocket: await attempt(() => new net.Socket().connect(tcpPort, '127.0.0.1')),
  ipcCaptured: await attempt(() => netConnect(ipcPath)),
  ipcSocket: await attempt(() => new net.Socket().connect(ipcPath)),
  pyricRoute: await new Promise((resolve) => {
    http
      .get('http://localhost:' + pyricPort + '/__pyric/init.json', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve(body));
      })
      .on('error', (e) => resolve(e.code ?? e.message));
  }),
};
await Promise.all([tcp, ipc, pyricHost].map((s) => new Promise((r) => s.close(r))));
console.log(JSON.stringify(outcomes));
`,
    );
  });

  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  const SANDBOX = { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' };

  it('does not disturb a plain child: localhost fetch works, exit 0, no verdict lines', () => {
    const res = runNode('local.mjs', SANDBOX);
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(res.stderr).not.toContain('net-guard');
    expect(res.stdout).toContain('LOCAL_OK');
    expect(res.status).toBe(0);
  });

  for (const [label, guard] of [
    ['an unset PYRIC_GUARD', undefined],
    ['PYRIC_GUARD=block', 'block'],
    ['PYRIC_GUARD=warn', 'warn'],
  ] as const) {
    it(`${label} refuses token requests with the guard cause, and lets every other host through`, () => {
      const res = runNode('fetches.mjs', { ...SANDBOX, PYRIC_GUARD: guard }, [NO_DNS]);
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual({
        oauth2: GUARD_BLOCKED_CODE,
        gtokenFetch: GUARD_BLOCKED_CODE,
        gtokenRequest: GUARD_BLOCKED_CODE,
        certs: 'FIXTURE_NO_DNS',
        firestore: 'FIXTURE_NO_DNS',
        fonts: 'FIXTURE_NO_DNS',
      });
      expect(res.stderr).toContain('net-guard BLOCK oauth2.googleapis.com (Google OAuth 2.0 token endpoint)');
      expect(res.stderr).toContain('net-guard BLOCK www.googleapis.com');
      expect(res.stderr).not.toContain('firestore.googleapis.com');
      expect(res.stderr).not.toContain('fonts.googleapis.com');
      expect(res.stderr).not.toContain('net-guard WARN');
      const warnNotice = res.stderr.includes('PYRIC_GUARD=warn no longer lets token requests through');
      expect(warnNotice).toBe(guard === 'warn');
    });
  }

  it('PYRIC_GUARD=off prints the disabled notice and refuses nothing', () => {
    const res = runNode('fetches.mjs', { ...SANDBOX, PYRIC_GUARD: 'off' }, [NO_DNS]);
    expect(res.stderr).toContain('net-guard disabled (PYRIC_GUARD=off)');
    const seen = JSON.parse(res.stdout.trim()) as Record<string, string>;
    expect(Object.values(seen).every((outcome) => outcome === 'FIXTURE_NO_DNS')).toBe(true);
  });

  it('PYRIC_GUARD_ALLOW does not open a token endpoint', () => {
    const res = runNode(
      'fetches.mjs',
      { ...SANDBOX, PYRIC_GUARD_ALLOW: 'https://oauth2.googleapis.com,www.googleapis.com' },
      [NO_DNS],
    );
    const seen = JSON.parse(res.stdout.trim()) as Record<string, string>;
    expect(seen.oauth2).toBe(GUARD_BLOCKED_CODE);
    expect(seen.gtokenFetch).toBe(GUARD_BLOCKED_CODE);
    expect(res.stderr).not.toContain('net-guard ALLOW');
  });

  it('refuses a plain http.request to the metadata server before it connects, with PYRIC_GUARD unset', () => {
    const res = runNode('metadata.mjs', SANDBOX);
    expect(res.status).toBe(0);
    const seen = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(seen.code).toBe(GUARD_BLOCKED_CODE);
    expect(seen.message).toContain('169.254.169.254');
    // Refused at the call, not after a connect attempt timed out.
    expect(seen.elapsed as number).toBeLessThan(2_000);
    expect(res.stderr).toContain('net-guard BLOCK 169.254.169.254');
    expect(res.stderr).toContain('via socket');
  }, 30_000);

  it('still intercepts http.request when node:http loaded before the guard', () => {
    const res = runNode('metadata.mjs', SANDBOX, ['preload-http.mjs']);
    expect(res.status).toBe(0);
    const seen = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(seen.code).toBe(GUARD_BLOCKED_CODE);
    expect(seen.elapsed as number).toBeLessThan(2_000);
    expect(res.stderr).toContain('net-guard BLOCK 169.254.169.254');
  }, 30_000);

  /** The token hosts `sockets.mjs` dials, keyed by the attempt that dials each. */
  const socketTokenAttempts = {
    capturedNetConnect: 'oauth2.googleapis.com',
    capturedCreateConnection: 'metadata.google.internal',
    socketConnect: 'iamcredentials.googleapis.com',
    capturedTlsConnect: 'sts.googleapis.com',
  } as const;

  it('refuses real sockets to token hosts however the caller reached connect, and lets Firestore through', () => {
    const res = runNode('sockets.mjs', SANDBOX, [NO_DNS]);
    expect(res.status).toBe(0);
    const seen = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    for (const [attemptName, host] of Object.entries(socketTokenAttempts)) {
      expect({ attemptName, outcome: seen[attemptName] }).toEqual({ attemptName, outcome: GUARD_BLOCKED_CODE });
      expect(res.stderr).toContain(`net-guard BLOCK ${host}`);
    }
    expect(seen.firestoreSocket).toBe('FIXTURE_NO_DNS');
    expect(seen.loopbackCaptured).toBe('connected');
    expect(seen.loopbackSocket).toBe('connected');
    expect(seen.ipcCaptured).toBe('connected');
    expect(seen.ipcSocket).toBe('connected');
    expect(seen.pyricRoute).toBe('/__pyric/init.json');
  }, 30_000);

  it('publishes the installed guard in block mode', () => {
    const res = runNode('published.mjs', SANDBOX);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout.trim())).toEqual({ mode: 'block', permit: 'function' });
  });

  it('stays inert without PYRIC_SANDBOX', () => {
    const res = runNode('local.mjs', { PYRIC_GUARD: 'block' });
    expect(res.stdout).toContain('LOCAL_OK');
    expect(res.stderr).not.toContain('net-guard');
    expect(res.status).toBe(0);
  });
});

// Keep the exported refusal shape honest for the callers that format it.
describe('EgressRefusal shape', () => {
  it('carries everything a log line needs', () => {
    const refusal = evaluateEgress('0xa9fea9fe', on) as EgressRefusal;
    expect(Object.keys(refusal).sort()).toEqual(['endpoint', 'host', 'service']);
    // The observed hostname is reported, in the one spelling.
    expect(refusal.host).toBe('169.254.169.254');
  });
});

describe('installNetGuard multi-slot undici globalDispatcher coverage', () => {
  const noNet = { connect: () => ({}), createConnection: () => ({}) };
  const noTls = { connect: () => ({}) };
  const noPrototypes = { agentPrototypes: [], socketPrototypes: [], requestPrototypes: [] };

  it('wraps undici.globalDispatcher.1, .2 (Node 24+), and dynamically discovered .N slots simultaneously', () => {
    const slot1 = Symbol.for('undici.globalDispatcher.1');
    const slot2 = Symbol.for('undici.globalDispatcher.2');
    const slot3 = Symbol.for('undici.globalDispatcher.3');
    const d1 = mockDispatcher();
    const d2 = mockDispatcher();
    const d3 = mockDispatcher();
    const scope: Record<symbol, unknown> = { [slot1]: d1, [slot2]: d2, [slot3]: d3 };
    const log = collector();
    const guard = installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1' },
      write: log.write,
      net: noNet,
      tls: noTls,
      ...noPrototypes,
    });
    expect(guard).not.toBeNull();
    expect(scope[slot1]).not.toBe(d1);
    expect(scope[slot2]).not.toBe(d2);
    expect(scope[slot3]).not.toBe(d3);

    const dispatchOn = (slot: symbol) => (scope[slot] as { dispatch: Dispatch }).dispatch;
    expect(() => dispatchOn(slot2)({ origin: 'https://oauth2.googleapis.com' }, {})).toThrow(
      /pyric net-guard blocked fetch egress to oauth2\.googleapis\.com/,
    );
    expect(() => dispatchOn(slot3)({ origin: 'https://sts.googleapis.com' }, {})).toThrow(
      /pyric net-guard blocked fetch egress to sts\.googleapis\.com/,
    );

    // Reassert wraps a newly replaced .2 slot without disturbing .1
    const firstWrapped1 = scope[slot1];
    scope[slot2] = mockDispatcher();
    guard!.reassert();
    expect(scope[slot1]).toBe(firstWrapped1);
    expect(() => dispatchOn(slot2)({ origin: 'https://iamcredentials.googleapis.com' }, {})).toThrow(
      /pyric net-guard blocked fetch egress to iamcredentials\.googleapis\.com/,
    );
    expect(log.lines.some((l) => l.includes('net-guard BLOCK oauth2.googleapis.com'))).toBe(true);
    guard!.stop();
  });
});
