import { afterEach, describe, expect, it } from 'bun:test';
import type { UserConfig } from 'vite';
import { NET_GUARD_GLOBAL, GUARD_BLOCKED_CODE } from '../../src/register/net-guard.js';
import { FIREBASE_AI_LOGIC_HOST } from '../../src/google-endpoints.js';
import type { PyricOptions } from '../../src/serve/vite-plugin.js';
import {
  VITE_SSR_GUARD_NOTE,
  VITE_SSR_ISSUE_URL,
  installViteNetGuard,
  viteGuardEnv,
} from '../../src/serve/vite-net-guard.js';
import { pyric } from '../../src/serve/vite-plugin.js';

type Connect = (...args: unknown[]) => unknown;

/** Stand-ins for every seam the guard patches, recording what got through. */
function fakeSeams() {
  const connected: string[] = [];
  const connect: Connect = (options) => {
    connected.push(String((options as { host?: string }).host));
    return 'socket';
  };
  const net = { connect, createConnection: connect };
  return {
    connected,
    hooks: {
      scope: {} as Record<symbol, unknown>,
      net,
      tls: { connect },
      agentPrototypes: [],
      socketPrototypes: [],
      requestPrototypes: [],
      argv: ['/usr/bin/node', '/app/node_modules/.bin/vite'],
    },
    net,
  };
}

function logLines() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line) };
}

describe('viteGuardEnv', () => {
  it('activates the guard and blocks when PYRIC_GUARD names no mode', () => {
    expect(viteGuardEnv({})).toMatchObject({ PYRIC_SANDBOX: 'vite-dev', PYRIC_GUARD: 'block' });
    expect(viteGuardEnv({ PYRIC_GUARD: '  ' })).toMatchObject({ PYRIC_GUARD: 'block' });
  });

  it('keeps a mode and an activator the environment already names', () => {
    const env = viteGuardEnv({ PYRIC_GUARD: 'warn', PYRIC_SANDBOX: 'remote', PYRIC_GUARD_ALLOW: 'a.example' });
    expect(env).toMatchObject({ PYRIC_GUARD: 'warn', PYRIC_SANDBOX: 'remote', PYRIC_GUARD_ALLOW: 'a.example' });
  });
});

describe('installViteNetGuard', () => {
  it('refuses a live Firestore connection by default and explains the SSR gap once', () => {
    const seams = fakeSeams();
    const log = logLines();
    const slot: Record<symbol, unknown> = {};
    const guard = installViteNetGuard({ env: {}, write: log.write, slot, hooks: seams.hooks });
    expect(guard?.mode).toBe('block');
    expect(slot[NET_GUARD_GLOBAL]).toBe(guard);

    let refusal: unknown;
    try {
      seams.net.connect({ host: 'firestore.googleapis.com', port: 443 });
    } catch (error) {
      refusal = error;
    }
    expect((refusal as { code?: string }).code).toBe(GUARD_BLOCKED_CODE);
    expect(seams.connected).toEqual([]);
    expect(() => seams.net.connect({ host: 'demo-default-rtdb.firebaseio.com', port: 443 })).toThrow();

    const blockLines = log.lines.filter((line) => line.includes(' BLOCK '));
    expect(blockLines).toHaveLength(2);
    expect(blockLines[0]).toContain('firestore.googleapis.com (Cloud Firestore) via socket from vite');
    const notes = log.lines.filter((line) => line === VITE_SSR_GUARD_NOTE);
    expect(notes).toHaveLength(1);
    expect(VITE_SSR_GUARD_NOTE).toContain(VITE_SSR_ISSUE_URL);
  });

  it('lets local and unlisted hosts through', () => {
    const seams = fakeSeams();
    installViteNetGuard({ env: {}, write: logLines().write, slot: {}, hooks: seams.hooks });
    seams.net.connect({ host: '127.0.0.1', port: 5173 });
    seams.net.connect({ host: 'registry.npmjs.org', port: 443 });
    expect(seams.connected).toEqual(['127.0.0.1', 'registry.npmjs.org']);
  });

  it('respects PYRIC_GUARD=warn and PYRIC_GUARD_ALLOW', () => {
    const warned = fakeSeams();
    const warnLog = logLines();
    installViteNetGuard({ env: { PYRIC_GUARD: 'warn' }, write: warnLog.write, slot: {}, hooks: warned.hooks });
    warned.net.connect({ host: 'firestore.googleapis.com', port: 443 });
    expect(warned.connected).toEqual(['firestore.googleapis.com']);
    expect(warnLog.lines.some((line) => line.includes(' WARN '))).toBe(true);
    expect(warnLog.lines).toContain(VITE_SSR_GUARD_NOTE);

    const allowed = fakeSeams();
    installViteNetGuard({
      env: { PYRIC_GUARD_ALLOW: 'firestore.googleapis.com' },
      write: logLines().write,
      slot: {},
      hooks: allowed.hooks,
    });
    allowed.net.connect({ host: 'firestore.googleapis.com', port: 443 });
    expect(allowed.connected).toEqual(['firestore.googleapis.com']);
    expect(() => allowed.net.connect({ host: 'identitytoolkit.googleapis.com', port: 443 })).toThrow();
  });

  it('installs nothing under PYRIC_GUARD=off', () => {
    const seams = fakeSeams();
    const log = logLines();
    const slot: Record<symbol, unknown> = {};
    expect(installViteNetGuard({ env: { PYRIC_GUARD: 'off' }, write: log.write, slot, hooks: seams.hooks })).toBeNull();
    seams.net.connect({ host: 'firestore.googleapis.com', port: 443 });
    expect(seams.connected).toEqual(['firestore.googleapis.com']);
    expect(slot[NET_GUARD_GLOBAL]).toBeUndefined();
    expect(log.lines).toHaveLength(1);
  });

  it('keeps a guard the register already installed, and installs once per process', () => {
    const registered = { mode: 'warn', permit() {} };
    const slot: Record<symbol, unknown> = { [NET_GUARD_GLOBAL]: registered };
    const seams = fakeSeams();
    expect(installViteNetGuard({ env: {}, write: logLines().write, slot, hooks: seams.hooks })).toBe(registered);

    const fresh: Record<symbol, unknown> = {};
    const off = logLines();
    installViteNetGuard({ env: { PYRIC_GUARD: 'off' }, write: off.write, slot: fresh, hooks: fakeSeams().hooks });
    installViteNetGuard({ env: { PYRIC_GUARD: 'off' }, write: off.write, slot: fresh, hooks: fakeSeams().hooks });
    expect(off.lines).toHaveLength(1);
  });
});

describe('pyric() installs the guard only for the dev server', () => {
  const slot = globalThis as unknown as Record<symbol, unknown>;
  const attempted = Symbol.for('pyric.viteNetGuardAttempted');
  const priorGuard = slot[NET_GUARD_GLOBAL];
  const priorAttempt = slot[attempted];
  const priorMode = process.env.PYRIC_GUARD;
  const writeStderr = process.stderr.write.bind(process.stderr);

  afterEach(() => {
    slot[NET_GUARD_GLOBAL] = priorGuard;
    slot[attempted] = priorAttempt;
    if (priorMode === undefined) delete process.env.PYRIC_GUARD;
    else process.env.PYRIC_GUARD = priorMode;
    process.stderr.write = writeStderr;
  });

  /** Runs the plugin's config hook under PYRIC_GUARD=off, so only the install notice can appear. */
  function runConfig(env: { command: 'serve' | 'build'; mode: string; isPreview?: boolean }): string[] {
    delete slot[NET_GUARD_GLOBAL];
    delete slot[attempted];
    process.env.PYRIC_GUARD = 'off';
    const written: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const plugin = pyric({ ui: false });
    const hook = plugin.config;
    if (!hook) throw new Error('pyric() plugin did not return a config hook');
    const configHook = typeof hook === 'function' ? hook : hook.handler;
    configHook({}, env) as UserConfig;
    process.stderr.write = writeStderr;
    return written.filter((line) => line.includes('net-guard'));
  }

  it('under vite dev', () => {
    expect(runConfig({ command: 'serve', mode: 'development' })).toHaveLength(1);
  });

  it('not for vite build or vite preview', () => {
    expect(runConfig({ command: 'build', mode: 'development' })).toEqual([]);
    expect(runConfig({ command: 'serve', mode: 'production', isPreview: true })).toEqual([]);
  });
});

describe('the AI mode decides whether Firebase AI Logic passes the guard', () => {
  const slot = globalThis as unknown as Record<symbol, unknown>;
  const attempted = Symbol.for('pyric.viteNetGuardAttempted');
  const keys = ['PYRIC_AI_MODE', 'PYRIC_AI_PASSTHROUGH', 'PYRIC_GUARD', 'PYRIC_GUARD_ALLOW'] as const;
  const priorGuard = slot[NET_GUARD_GLOBAL];
  const priorAttempt = slot[attempted];
  const priorEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    slot[NET_GUARD_GLOBAL] = priorGuard;
    slot[attempted] = priorAttempt;
    for (const key of keys) {
      const value = priorEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** A real guard over stand-in seams, published where the plugin finds it, then the plugin's dev config hook. */
  function devServerGuard(options: PyricOptions, env: Record<string, string>) {
    delete slot[NET_GUARD_GLOBAL];
    delete slot[attempted];
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, env);
    const seams = fakeSeams();
    installViteNetGuard({ env: {}, write: logLines().write, hooks: seams.hooks });
    const hook = pyric({ ui: false, ...options }).config;
    if (!hook) throw new Error('pyric() plugin did not return a config hook');
    const configHook = typeof hook === 'function' ? hook : hook.handler;
    configHook({}, { command: 'serve', mode: 'development' });
    const reaches = (host: string): boolean => {
      try {
        seams.net.connect({ host, port: 443 });
        return true;
      } catch (error) {
        expect((error as { code?: string }).code).toBe(GUARD_BLOCKED_CODE);
        return false;
      }
    };
    return reaches;
  }

  const productionSettings: Array<[string, PyricOptions, Record<string, string>]> = [
    ['ai.mode production', { ai: { mode: 'production' } }, {}],
    ['PYRIC_AI_MODE=production', {}, { PYRIC_AI_MODE: 'production' }],
    ['PYRIC_AI_PASSTHROUGH=1', {}, { PYRIC_AI_PASSTHROUGH: '1' }],
  ];

  for (const [name, options, env] of productionSettings) {
    it(`${name} permits ${FIREBASE_AI_LOGIC_HOST} and keeps other Firebase hosts blocked`, () => {
      const reaches = devServerGuard(options, env);
      expect(reaches(FIREBASE_AI_LOGIC_HOST)).toBe(true);
      expect(reaches('firestore.googleapis.com')).toBe(false);
      expect(reaches('identitytoolkit.googleapis.com')).toBe(false);
      expect(reaches('aiplatform.googleapis.com')).toBe(false);
    });
  }

  it(`sandbox mode keeps ${FIREBASE_AI_LOGIC_HOST} and every other Firebase host blocked`, () => {
    const reaches = devServerGuard({}, {});
    expect(reaches(FIREBASE_AI_LOGIC_HOST)).toBe(false);
    expect(reaches('firestore.googleapis.com')).toBe(false);
    expect(reaches('demo-default-rtdb.firebaseio.com')).toBe(false);
  });

  it('an explicit ai.mode sandbox outranks PYRIC_AI_MODE=production', () => {
    const reaches = devServerGuard({ ai: { mode: 'sandbox' } }, { PYRIC_AI_MODE: 'production' });
    expect(reaches(FIREBASE_AI_LOGIC_HOST)).toBe(false);
  });
});
