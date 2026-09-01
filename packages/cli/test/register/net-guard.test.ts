/**
 * TA.3 — the runtime network guard (`src/register/net-guard.ts`).
 *
 * The production-leak invariant's ENFORCEMENT layer: once `PYRIC_SANDBOX` is
 * set, a pyric-launched Node process that still reaches a LIVE Google/Firebase
 * endpoint is a sandbox escape, and the guard has to say so (warn) or stop it
 * (block).
 *
 * Test shape, and why:
 *  - The interception SEAM is unit-tested against MOCK dispatchers. We cannot
 *    rewrite DNS, so a "real" warn-mode test would have to actually contact
 *    Google; instead the seam that decides + logs + passes through is exercised
 *    directly, with the same catalog the production path uses.
 *  - The dispatcher hook itself only works on a real Node undici (Bun serves
 *    `fetch` natively and never reads
 *    `Symbol.for('undici.globalDispatcher.1')`), so the two end-to-end facts —
 *    "installing the guard does not break an ordinary child" and "block mode
 *    fails the fetch with the GUARD's cause, not DNS's" — are proven in
 *    `node --import` subprocesses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GUARD_BLOCKED_CODE,
  evaluateEgress,
  installNetGuard,
  parseAllowHosts,
  parseGuardMode,
  wrapDispatcher,
  type EgressVerdict,
} from '../../src/register/net-guard.js';

// ─── mode + allowlist parsing ───────────────────────────────────────────────

describe('parseGuardMode', () => {
  it('defaults to warn when unset or empty', () => {
    expect(parseGuardMode(undefined)).toBe('warn');
    expect(parseGuardMode('')).toBe('warn');
    expect(parseGuardMode('   ')).toBe('warn');
  });

  it('accepts the three knob values case/space-insensitively', () => {
    expect(parseGuardMode('block')).toBe('block');
    expect(parseGuardMode(' BLOCK ')).toBe('block');
    expect(parseGuardMode('off')).toBe('off');
    expect(parseGuardMode('Off')).toBe('off');
    expect(parseGuardMode('warn')).toBe('warn');
  });

  it('falls back to the safe default on an unknown value', () => {
    expect(parseGuardMode('nope')).toBe('warn');
    expect(parseGuardMode('true')).toBe('warn');
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

// ─── the decision (catalog + allowlist + alwaysBlock) ───────────────────────

const warn = { mode: 'warn' as const, allow: [] as string[] };
const block = { mode: 'block' as const, allow: [] as string[] };

describe('evaluateEgress', () => {
  it('ignores hosts that are not production Google endpoints', () => {
    expect(evaluateEgress('127.0.0.1', warn)).toBeNull();
    expect(evaluateEgress('localhost', warn)).toBeNull();
    expect(evaluateEgress('example.com', block)).toBeNull();
    // label-boundary: a lookalike is NOT a catalog host
    expect(evaluateEgress('evilfirebaseio.com', block)).toBeNull();
  });

  it('warns (but permits) a catalog host in the default warn mode', () => {
    const v = evaluateEgress('firestore.googleapis.com', warn);
    expect(v).toMatchObject({
      verdict: 'warn',
      permitted: true,
      host: 'firestore.googleapis.com',
      service: 'Cloud Firestore',
    });
  });

  it('blocks a catalog host in block mode', () => {
    expect(evaluateEgress('identitytoolkit.googleapis.com', block)).toMatchObject({
      verdict: 'block',
      permitted: false,
      service: 'Firebase Authentication',
    });
  });

  it('matches subdomains of a catalog suffix through the shared lookup', () => {
    expect(evaluateEgress('us-central1-demo.cloudfunctions.net', warn)).toMatchObject({
      verdict: 'warn',
      service: 'Cloud Functions',
    });
  });

  it('is silent for every host when the guard is off', () => {
    const off = { mode: 'off' as const, allow: [] };
    expect(evaluateEgress('firestore.googleapis.com', off)).toBeNull();
    // "off is off" — even the metadata IP.
    expect(evaluateEgress('169.254.169.254', off)).toBeNull();
  });

  it('blocks the GCE metadata IP even in warn mode (alwaysBlock)', () => {
    expect(evaluateEgress('169.254.169.254', warn)).toMatchObject({
      verdict: 'block',
      permitted: false,
      service: 'GCE metadata server',
      alwaysBlock: true,
    });
  });

  it('refuses to let the allowlist unblock the metadata IP', () => {
    expect(evaluateEgress('169.254.169.254', { mode: 'warn', allow: ['169.254.169.254'] })).toMatchObject({
      verdict: 'block',
      permitted: false,
    });
  });

  it('permits an allowlisted catalog host, in warn AND block mode, but still reports it', () => {
    const allow = ['aiplatform.googleapis.com'];
    for (const mode of ['warn', 'block'] as const) {
      expect(evaluateEgress('aiplatform.googleapis.com', { mode, allow })).toMatchObject({
        verdict: 'allow',
        permitted: true,
        service: 'Vertex AI',
      });
    }
  });

  it('applies the allowlist on label boundaries too', () => {
    const allow = ['cloudfunctions.net'];
    expect(evaluateEgress('us-central1-demo.cloudfunctions.net', { mode: 'block', allow })).toMatchObject({
      verdict: 'allow',
      permitted: true,
    });
    expect(evaluateEgress('notcloudfunctions.net', { mode: 'block', allow: ['cloudfunctions.net'] })).toBeNull();
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

describe('wrapDispatcher', () => {
  it('passes a non-catalog origin straight through, silently', () => {
    const real = mockDispatcher();
    const log = collector();
    const handler = { onData() {} };
    const wrapped = wrapDispatcher(real, { mode: 'warn', allow: [], write: log.write });
    expect(wrapped.dispatch({ origin: 'http://127.0.0.1:5000', path: '/x' }, handler)).toBe(true);
    expect(real.calls).toHaveLength(1);
    expect(log.lines).toEqual([]);
  });

  it('WARN: logs one line and still completes the request', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, { mode: 'warn', allow: [], write: log.write, context: 'next' });
    wrapped.dispatch({ origin: 'https://firestore.googleapis.com', path: '/v1/x' }, { id: 1 });
    expect(real.calls).toHaveLength(1);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('net-guard WARN firestore.googleapis.com');
    expect(log.lines[0]).toContain('Cloud Firestore');
    expect(log.lines[0]).toContain('from next');
    expect(log.lines[0]!.endsWith('\n')).toBe(true);
    // The request path can carry tokens/ids — it must never be logged.
    expect(log.lines[0]).not.toContain('/v1/x');
  });

  it('passes the handler through by IDENTITY and untouched (v6/v7 cross-version handoff)', () => {
    const real = mockDispatcher();
    const log = collector();
    const handler = Object.freeze({ onConnect() {}, onHeaders() {} });
    const opts = { origin: new URL('https://firestore.googleapis.com'), path: '/v1/x' };
    const wrapped = wrapDispatcher(real, { mode: 'warn', allow: [], write: log.write });
    wrapped.dispatch(opts, handler);
    expect(real.calls[0]!.handler).toBe(handler);
    expect(real.calls[0]!.opts).toBe(opts);
  });

  it('BLOCK: never reaches the real dispatcher and throws the guard error', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, { mode: 'block', allow: [], write: log.write });
    let thrown: unknown;
    try {
      wrapped.dispatch({ origin: 'https://firestore.googleapis.com', path: '/v1/x' }, {});
    } catch (e) {
      thrown = e;
    }
    expect(real.calls).toHaveLength(0);
    expect((thrown as { code?: string }).code).toBe(GUARD_BLOCKED_CODE);
    expect((thrown as Error).message).toContain('firestore.googleapis.com');
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('net-guard BLOCK firestore.googleapis.com');
  });

  it('BLOCK: the metadata IP is refused even under warn mode', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, { mode: 'warn', allow: [], write: log.write });
    expect(() => wrapped.dispatch({ origin: 'http://169.254.169.254', path: '/x' }, {})).toThrow(
      /169\.254\.169\.254/,
    );
    expect(real.calls).toHaveLength(0);
    expect(log.lines[0]).toContain('net-guard BLOCK 169.254.169.254');
  });

  it('ALLOW: an allowlisted catalog host passes through and is still reported once', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, {
      mode: 'block',
      allow: ['aiplatform.googleapis.com'],
      write: log.write,
    });
    expect(wrapped.dispatch({ origin: 'https://aiplatform.googleapis.com', path: '/p' }, {})).toBe(true);
    expect(real.calls).toHaveLength(1);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('net-guard ALLOW aiplatform.googleapis.com');
    expect(log.lines[0]).toContain('PYRIC_GUARD_ALLOW');
  });

  it('logs each host only once — a dev server retries constantly', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, { mode: 'warn', allow: [], write: log.write });
    for (let i = 0; i < 5; i++) {
      wrapped.dispatch({ origin: 'https://firestore.googleapis.com', path: `/v1/${i}` }, {});
    }
    wrapped.dispatch({ origin: 'https://identitytoolkit.googleapis.com', path: '/v1' }, {});
    expect(real.calls).toHaveLength(6);
    expect(log.lines).toHaveLength(2);
    expect(log.lines[1]).toContain('identitytoolkit.googleapis.com');
  });

  it('forwards every other dispatcher member to the real instance', () => {
    const real = mockDispatcher();
    const log = collector();
    const wrapped = wrapDispatcher(real, { mode: 'warn', allow: [], write: log.write }) as unknown as {
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
    const wrapped = wrapDispatcher(real, { mode: 'block', allow: [], write: log.write });
    expect(wrapped.dispatch({ path: '/x' }, {})).toBe(true);
    expect(wrapped.dispatch({ origin: 'not a url' }, {})).toBe(true);
    expect(log.lines).toEqual([]);
  });
});

// ─── install: the off notice, the scope handoff, the re-assert ──────────────

/** A stand-in for `globalThis` so no test ever mutates the real one. */
function fakeScope(dispatcher: unknown): Record<symbol, unknown> {
  return { [Symbol.for('undici.globalDispatcher.1')]: dispatcher };
}

const UNDICI = Symbol.for('undici.globalDispatcher.1');

describe('installNetGuard', () => {
  const noNet = { connect: () => ({}), createConnection: () => ({}) };
  const noTls = { connect: () => ({}) };

  it('is inert and silent when PYRIC_SANDBOX is absent', () => {
    const real = mockDispatcher();
    const scope = fakeScope(real);
    const log = collector();
    const guard = installNetGuard({ scope, env: {}, write: log.write, net: noNet, tls: noTls });
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
    });
    expect(guard).toBeNull();
    expect(scope[UNDICI]).toBe(real);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('net-guard disabled (PYRIC_GUARD=off)');
    // The off notice must still name what is being given up.
    expect(log.lines[0]).toContain('169.254.169.254');
  });

  it('warn mode replaces the global dispatcher and stays quiet until a hit', () => {
    const real = mockDispatcher();
    const scope = fakeScope(real);
    const log = collector();
    const guard = installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1' },
      write: log.write,
      net: noNet,
      tls: noTls,
      argv: ['/usr/bin/node', '/app/node_modules/.bin/next'],
    });
    expect(guard).not.toBeNull();
    expect(scope[UNDICI]).not.toBe(real);
    expect(log.lines).toEqual([]);
    (scope[UNDICI] as { dispatch: (o: unknown, h: unknown) => unknown }).dispatch(
      { origin: 'https://firestore.googleapis.com', path: '/v1' },
      {},
    );
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain('from next');
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
    })!;
    const installed = scope[UNDICI];
    // Next (or anyone) overwrites us with a fresh agent.
    const usurper = mockDispatcher();
    scope[UNDICI] = usurper;
    guard.reassert();
    expect(scope[UNDICI]).not.toBe(usurper);
    expect(scope[UNDICI]).not.toBe(installed);
    // and the new wrapper still guards, delegating to the usurper
    (scope[UNDICI] as { dispatch: (o: unknown, h: unknown) => unknown }).dispatch(
      { origin: 'https://firestore.googleapis.com', path: '/v1' },
      {},
    );
    expect(usurper.calls).toHaveLength(1);
    expect(log.lines).toHaveLength(1);
    // A reassert with nothing to do is a no-op.
    const current = scope[UNDICI];
    guard.reassert();
    expect(scope[UNDICI]).toBe(current);
  });

  it('wraps net/tls connect as the non-fetch backstop, blocking with the guard code', () => {
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
    installNetGuard({
      scope,
      env: { PYRIC_SANDBOX: '1', PYRIC_GUARD: 'block' },
      write: log.write,
      net,
      tls,
    });

    // untouched host → passthrough
    expect(net.connect({ host: '127.0.0.1', port: 5000 })).toEqual({ sock: true });
    expect(netCalls).toHaveLength(1);

    // positional (port, host) form
    expect(() => net.connect(443, 'firestore.googleapis.com')).toThrow(/firestore\.googleapis\.com/);
    expect(netCalls).toHaveLength(1);

    // options form, through tls
    let thrown: unknown;
    try {
      tls.connect({ host: 'identitytoolkit.googleapis.com', port: 443 });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe(GUARD_BLOCKED_CODE);
    expect(tlsCalls).toHaveLength(0);

    // createConnection shares the policy
    expect(() => net.createConnection({ host: 'firebaseio.com' })).toThrow(/firebaseio\.com/);

    // an IPC path is not a host
    expect(net.connect('/tmp/some.sock')).toEqual({ sock: true });

    expect(log.lines.map((l) => l.split(' ')[3])).toEqual([
      'firestore.googleapis.com',
      'identitytoolkit.googleapis.com',
      'firebaseio.com',
    ]);
    expect(log.lines[0]).toContain('via socket');
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
): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync('node', ['--import', registerUrl, script], {
    cwd: fixtureDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: undefined,
      PYRIC_SANDBOX: undefined,
      PYRIC_GUARD: undefined,
      PYRIC_GUARD_ALLOW: undefined,
      ...env,
    },
    timeout: 30_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('net-guard under `node --import @pyric/cli/register`', () => {
  beforeAll(() => {
    if (!existsSync(registerDist)) {
      throw new Error(`dist/register/index.js missing — run \`bun run build\` first (${registerDist})`);
    }
    fixtureDir = mkdtempSync(join(tmpdir(), 'pyric-net-guard-'));
    writeFileSync(
      join(fixtureDir, 'package.json'),
      JSON.stringify({ name: 'net-guard-fixture', type: 'module' }),
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
// http.request goes through the net.connect backstop — it must be untouched.
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

    // 2. Block mode against a real catalog host: the fetch must fail with the
    //    GUARD's cause, never DNS/ENOTFOUND — proof the guard, not the network,
    //    stopped it.
    writeFileSync(
      join(fixtureDir, 'blocked.mjs'),
      `let err;
try {
  await fetch('https://firestore.googleapis.com/v1/projects/x/databases/(default)/documents');
} catch (e) {
  err = e;
}
// Report, never assert: off/allowlist modes reach the real network, whose
// outcome depends on whether this machine is online. Only the guard's own
// fingerprint (\`causeCode\`) is a stable fact.
console.log(JSON.stringify(err === undefined ? { rejected: false, causeCode: null } : {
  rejected: true,
  name: err.name,
  message: err.message,
  causeCode: err.cause?.code ?? null,
  causeMessage: err.cause?.message ?? null,
}));
`,
    );
  });

  afterAll(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('does not disturb a plain child: localhost fetch works, exit 0, no verdict lines', () => {
    const res = runNode('local.mjs', { PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000' });
    expect(res.stderr).toContain('@pyric/cli/register: active');
    expect(res.stderr).not.toContain('net-guard WARN');
    expect(res.stderr).not.toContain('net-guard BLOCK');
    expect(res.stdout).toContain('LOCAL_OK');
    expect(res.status).toBe(0);
  });

  it('PYRIC_GUARD=block fails a catalog-host fetch with the guard cause (never DNS)', () => {
    const res = runNode('blocked.mjs', {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000',
      PYRIC_GUARD: 'block',
    });
    expect(res.status).toBe(0);
    const seen = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(seen.rejected).toBe(true);
    expect(seen.name).toBe('TypeError');
    expect(seen.message).toBe('fetch failed');
    expect(seen.causeCode).toBe(GUARD_BLOCKED_CODE);
    expect(seen.causeMessage).toContain('firestore.googleapis.com');
    expect(res.stderr).toContain('net-guard BLOCK firestore.googleapis.com');
    expect(res.stderr).toContain('Cloud Firestore');
  });

  it('PYRIC_GUARD=off prints the disabled notice and lets the request reach the network', () => {
    const res = runNode('blocked.mjs', {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000',
      PYRIC_GUARD: 'off',
    });
    expect(res.stderr).toContain('net-guard disabled (PYRIC_GUARD=off)');
    // Whatever happens on the wire (offline CI → DNS error), it is NOT ours.
    const seen = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(seen.causeCode).not.toBe(GUARD_BLOCKED_CODE);
  });

  it('PYRIC_GUARD_ALLOW permits a catalog host and still reports it', () => {
    const res = runNode('blocked.mjs', {
      PYRIC_SANDBOX: 'remote:http://127.0.0.1:5000',
      PYRIC_GUARD: 'block',
      PYRIC_GUARD_ALLOW: 'https://firestore.googleapis.com',
    });
    expect(res.stderr).toContain('net-guard ALLOW firestore.googleapis.com');
    const seen = JSON.parse(res.stdout.trim()) as Record<string, unknown>;
    expect(seen.causeCode).not.toBe(GUARD_BLOCKED_CODE);
  });

  it('stays inert without PYRIC_SANDBOX', () => {
    const res = runNode('local.mjs', { PYRIC_GUARD: 'block' });
    expect(res.stdout).toContain('LOCAL_OK');
    expect(res.stderr).not.toContain('net-guard');
    expect(res.status).toBe(0);
  });
});

// Keep the exported verdict shape honest for the callers that format it.
describe('EgressVerdict shape', () => {
  it('carries everything a log line needs', () => {
    const v = evaluateEgress('firebasestorage.googleapis.com', warn) as EgressVerdict;
    expect(Object.keys(v).sort()).toEqual(['endpoint', 'host', 'permitted', 'service', 'verdict']);
    // The observed hostname is reported; the catalog suffix is kept alongside.
    const sub = evaluateEgress('us-central1-demo.cloudfunctions.net', warn) as EgressVerdict;
    expect(sub.host).toBe('us-central1-demo.cloudfunctions.net');
    expect(sub.endpoint).toBe('cloudfunctions.net');
  });
});
