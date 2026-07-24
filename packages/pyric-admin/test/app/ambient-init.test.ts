/**
 * Ambient init — bare `initializeApp()` + environment (adoption
 * experience, layer 3). The user's server code contains zero pyric
 * identifiers; `PYRIC_SANDBOX` decides the backend, and the remote
 * handle comes from the factory `@pyric/cli/register` installs at
 * `globalThis[Symbol.for('pyric.remote.sandboxFactory')]`.
 *
 * These tests install a FAKE factory (the real one is `@pyric/cli`'
 * concern — the global symbol is the seam) and cover:
 *   - env unset → prod arm, factory never consulted
 *   - `remote` / `remote:<url>` parsing (url after the FIRST colon)
 *   - the one-line stderr activation log (with and without url)
 *   - missing-factory remediation message
 *   - production guard (`NODE_ENV=production`) + `PYRIC_SANDBOX_FORCE=1`
 *   - explicit configs bypass the env entirely
 *   - unrecognized activator values throw (never silently fall to prod)
 */

import { afterEach, beforeEach, describe, it, expect } from 'bun:test';

import {
  REMOTE_SANDBOX_FACTORY,
  initializeSandbox,
  type RemoteSandbox,
  type RemoteSandboxFactoryOptions,
} from 'pyric/sandbox';

import {
  cert,
  deleteApp,
  getApps,
  initializeApp,
  isSandboxAdminApp,
} from '../../src/app/index.js';

// ─── Environment / global scaffolding ───────────────────────────────────

type FactoryGlobal = { [REMOTE_SANDBOX_FACTORY]?: unknown };

const savedEnv: Record<string, string | undefined> = {};
let savedFactory: unknown;
let savedStderrWrite: typeof process.stderr.write;
let stderrLines: string[];

beforeEach(() => {
  for (const key of ['PYRIC_SANDBOX', 'PYRIC_SANDBOX_FORCE', 'NODE_ENV']) {
    savedEnv[key] = process.env[key];
  }
  delete process.env.PYRIC_SANDBOX;
  delete process.env.PYRIC_SANDBOX_FORCE;
  savedFactory = (globalThis as FactoryGlobal)[REMOTE_SANDBOX_FACTORY];
  delete (globalThis as FactoryGlobal)[REMOTE_SANDBOX_FACTORY];
  // Capture the activation log without polluting test output.
  stderrLines = [];
  savedStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stderr.write = savedStderrWrite;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (savedFactory === undefined) {
    delete (globalThis as FactoryGlobal)[REMOTE_SANDBOX_FACTORY];
  } else {
    (globalThis as FactoryGlobal)[REMOTE_SANDBOX_FACTORY] = savedFactory;
  }
  await Promise.all(getApps().map((app) => deleteApp(app)));
});

/** Install a fake factory; returns the calls it received and the handle
 *  it mints. The handle is a plain sentinel object — ambient init must
 *  register it verbatim as the app's `sandbox`, without touching it. */
function installFakeFactory(): {
  calls: Array<RemoteSandboxFactoryOptions | undefined>;
  handle: RemoteSandbox;
} {
  const handle = { __fake: 'remote-sandbox' } as unknown as RemoteSandbox;
  const calls: Array<RemoteSandboxFactoryOptions | undefined> = [];
  (globalThis as FactoryGlobal)[REMOTE_SANDBOX_FACTORY] = (
    opts?: RemoteSandboxFactoryOptions,
  ) => {
    calls.push(opts);
    return handle;
  };
  return { calls, handle };
}

// ─── Env unset: exactly today's prod behavior ───────────────────────────

describe('ambient init — PYRIC_SANDBOX unset', () => {
  it('bare initializeApp() refuses to select production inside the mirror', () => {
    const { calls } = installFakeFactory();
    expect(() => initializeApp()).toThrow(/sandbox-only mirror.*no sandbox is active/s);
    expect(calls).toHaveLength(0);
    expect(stderrLines).toHaveLength(0);
  });

  it('empty-string PYRIC_SANDBOX is treated as unset', () => {
    const { calls } = installFakeFactory();
    process.env.PYRIC_SANDBOX = '';
    expect(() => initializeApp()).toThrow(/sandbox-only mirror.*no sandbox is active/s);
    expect(calls).toHaveLength(0);
  });
});

// ─── Activation + env parsing ───────────────────────────────────────────

describe('ambient init — PYRIC_SANDBOX set', () => {
  it('remote → factory called with {}, sandbox arm registered, one log line', () => {
    const { calls, handle } = installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote';

    const app = initializeApp();
    expect(isSandboxAdminApp(app)).toBe(true);
    if (isSandboxAdminApp(app)) expect(app.sandbox).toBe(handle);
    expect(calls).toEqual([{}]);
    expect(stderrLines).toEqual(['pyric: firebase-admin routed to sandbox\n']);
  });

  it('remote:<url> → factory called with { url }, url in the log line', () => {
    const { calls } = installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote:http://localhost:5179';

    initializeApp();
    // Split on the FIRST colon only — the url itself contains colons.
    expect(calls).toEqual([{ url: 'http://localhost:5179' }]);
    expect(stderrLines).toEqual([
      'pyric: firebase-admin routed to sandbox at http://localhost:5179\n',
    ]);
  });

  it('repeated bare calls return the existing app and log only once', () => {
    const { calls } = installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote';
    const first = initializeApp();
    expect(initializeApp()).toBe(first);
    expect(calls).toHaveLength(1);
    expect(stderrLines).toHaveLength(1);
  });

  it('remote: with an empty url throws', () => {
    installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote:';
    expect(() => initializeApp()).toThrow(/empty url/);
  });

  it('unrecognized values throw instead of silently falling through to prod', () => {
    installFakeFactory();
    process.env.PYRIC_SANDBOX = 'local';
    expect(() => initializeApp()).toThrow(
      /unrecognized PYRIC_SANDBOX value "local".*"remote".*"remote:<url>"/s,
    );
    expect(getApps()).toHaveLength(0); // nothing half-registered
  });

  it('explicit configs bypass the env entirely (no factory call, no log)', () => {
    const { calls } = installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote';

    const sandbox = initializeSandbox();
    const app = initializeApp({ sandbox });
    expect(isSandboxAdminApp(app) && app.sandbox === sandbox).toBe(true);
    expect(calls).toHaveLength(0);
    expect(stderrLines).toHaveLength(0);
  });
});

// ─── Missing factory ────────────────────────────────────────────────────

describe('ambient init — factory global absent', () => {
  it('throws with the pyric dev / --import @pyric/cli/register remediation', () => {
    process.env.PYRIC_SANDBOX = 'remote';
    expect(() => initializeApp()).toThrow(
      /pyric\.remote\.sandboxFactory.*pyric dev.*--import @pyric\/cli\/register.*NODE_OPTIONS/s,
    );
    expect(getApps()).toHaveLength(0); // nothing half-registered
    expect(stderrLines).toHaveLength(0); // no activation log on failure
  });
});

// ─── Production guard ───────────────────────────────────────────────────

describe('ambient init — production guard', () => {
  it('NODE_ENV=production + PYRIC_SANDBOX refuses to route', () => {
    installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote';
    process.env.NODE_ENV = 'production';
    expect(() => initializeApp()).toThrow(
      /NODE_ENV is "production".*refusing to route.*PYRIC_SANDBOX_FORCE=1/s,
    );
    expect(getApps()).toHaveLength(0);
  });

  it('PYRIC_SANDBOX_FORCE=1 overrides the guard', () => {
    const { handle } = installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote';
    process.env.NODE_ENV = 'production';
    process.env.PYRIC_SANDBOX_FORCE = '1';
    const app = initializeApp();
    expect(isSandboxAdminApp(app)).toBe(true);
    if (isSandboxAdminApp(app)) expect(app.sandbox).toBe(handle);
    expect(stderrLines).toEqual(['pyric: firebase-admin routed to sandbox\n']);
  });

  it('other PYRIC_SANDBOX_FORCE values do not override', () => {
    installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote';
    process.env.NODE_ENV = 'production';
    process.env.PYRIC_SANDBOX_FORCE = 'true';
    expect(() => initializeApp()).toThrow(/refusing to route/);
  });

  it('non-production NODE_ENV values route normally', () => {
    installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote';
    process.env.NODE_ENV = 'development';
    const app = initializeApp();
    expect(isSandboxAdminApp(app)).toBe(true);
  });

  it('cert returns an inert credential object', () => {
    expect(cert({ projectId: 'demo' })).toEqual({
      [Symbol.for('pyric.admin.credential')]: 'cert',
    });
  });

  it('initializeApp with production options falls back to ambient sandbox initialization when PYRIC_SANDBOX is set', () => {
    const { handle } = installFakeFactory();
    process.env.PYRIC_SANDBOX = 'remote';
    const app = initializeApp({
      projectId: 'demo',
      credential: cert({ projectId: 'demo' }),
    });
    expect(isSandboxAdminApp(app)).toBe(true);
    if (isSandboxAdminApp(app)) expect(app.sandbox).toBe(handle);
  });

  it('accepts 1 and true as valid PYRIC_SANDBOX activator strings', () => {
    const { handle } = installFakeFactory();
    for (const val of ['1', 'true']) {
      process.env.PYRIC_SANDBOX = val;
      const app = initializeApp(undefined, `test-app-${val}`);
      expect(isSandboxAdminApp(app)).toBe(true);
      if (isSandboxAdminApp(app)) expect(app.sandbox).toBe(handle);
    }
  });
});
