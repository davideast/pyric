import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { withPyric } from '../../../src/next/index.js';

describe('withPyric Next.js configuration wrapper', () => {
  const origNodeEnv = process.env.NODE_ENV;
  const origPyricSandbox = process.env.PYRIC_SANDBOX;
  const origPyricSandboxForce = process.env.PYRIC_SANDBOX_FORCE;
  const origPyricSandboxPort = process.env.PYRIC_SANDBOX_PORT;

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.PYRIC_SANDBOX = 'remote:http://127.0.0.1:4000';
    delete process.env.PYRIC_SANDBOX_FORCE;
    delete process.env.PYRIC_SANDBOX_PORT;
  });

  afterEach(() => {
    process.env.NODE_ENV = origNodeEnv;
    if (origPyricSandbox !== undefined) {
      process.env.PYRIC_SANDBOX = origPyricSandbox;
    } else {
      delete process.env.PYRIC_SANDBOX;
    }
    if (origPyricSandboxForce !== undefined) {
      process.env.PYRIC_SANDBOX_FORCE = origPyricSandboxForce;
    } else {
      delete process.env.PYRIC_SANDBOX_FORCE;
    }
    if (origPyricSandboxPort !== undefined) {
      process.env.PYRIC_SANDBOX_PORT = origPyricSandboxPort;
    } else {
      delete process.env.PYRIC_SANDBOX_PORT;
    }
  });

  it('acts as an identity passthrough under NODE_ENV=production without force', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.PYRIC_SANDBOX;
    const originalConfig = { reactStrictMode: true };
    const res = withPyric(originalConfig);
    expect(res).toBe(originalConfig);
  });

  it('activates under NODE_ENV=production when PYRIC_SANDBOX_FORCE=1 is set', () => {
    process.env.NODE_ENV = 'production';
    process.env.PYRIC_SANDBOX_FORCE = '1';
    process.env.PYRIC_SANDBOX = 'local';
    const res = withPyric({ reactStrictMode: true }) as Record<string, any>;
    expect(res.serverExternalPackages).toContain('firebase');
    expect(res.serverExternalPackages).toContain('firebase-admin');
  });

  it('throws an error if PYRIC_SANDBOX is missing during non-production builds (bundler guard)', () => {
    delete process.env.PYRIC_SANDBOX;
    expect(() => withPyric({})).toThrow(/Next\.js development server started without active Pyric sandbox/);
  });

  it('allows execution when PYRIC_SANDBOX is missing if { guard: false } is passed', () => {
    delete process.env.PYRIC_SANDBOX;
    const res = withPyric({}, { guard: false }) as Record<string, any>;
    expect(res.serverExternalPackages).toContain('firebase');
  });

  it('injects firebase and firebase-admin into serverExternalPackages with deduplication', () => {
    const config = {
      serverExternalPackages: ['existing-pkg', 'firebase'],
      experimental: {
        serverComponentsExternalPackages: ['other-pkg', 'firebase-admin'],
      },
    };
    const res = withPyric(config) as Record<string, any>;
    expect(res.serverExternalPackages).toEqual(['existing-pkg', 'firebase', 'firebase-admin']);
    expect(res.experimental.serverComponentsExternalPackages).toEqual([
      'other-pkg',
      'firebase-admin',
      'firebase',
    ]);
  });

  it('configures client-side Webpack aliases and builtin fallbacks only for client builds (!isServer)', () => {
    let calledWithConfig: any = null;
    const customWebpack = (cfg: any, options: any) => {
      calledWithConfig = cfg;
      cfg.customProperty = options.isServer ? 'server-build' : 'client-build';
      return cfg;
    };

    const res = withPyric({ webpack: customWebpack }) as Record<string, any>;
    expect(typeof res.webpack).toBe('function');

    // Server build: should NOT alias or add fallbacks
    const serverConfig: any = {};
    const serverResult = res.webpack(serverConfig, { isServer: true });
    expect(serverResult.customProperty).toBe('server-build');
    expect(serverResult.resolve?.alias?.['firebase/app']).toBeUndefined();
    expect(serverResult.resolve?.fallback?.fs).toBeUndefined();

    // Client build: SHOULD alias and add built-in fallbacks
    const clientConfig: any = {};
    const clientResult = res.webpack(clientConfig, { isServer: false });
    expect(clientResult.customProperty).toBe('client-build');
    expect(clientResult.resolve.alias['firebase/app']).toContain('/entries/app.');
    expect(clientResult.resolve.alias['firebase/firestore']).toContain('/entries/firestore.');
    expect(clientResult.resolve.fallback.fs).toBe(false);
    expect(clientResult.resolve.fallback.path).toBe(false);
    expect(clientResult.experiments.topLevelAwait).toBe(true);
    expect(clientResult.output.environment.asyncFunction).toBe(true);
  });

  it('configures Turbopack aliases for client SDKs', () => {
    const res = withPyric({
      turbopack: { resolveAlias: { modern: 'alias' } },
      turbo: { resolveAlias: { existing: 'alias' } },
      experimental: { turbo: { resolveAlias: { legacy: 'alias' } } },
    }) as Record<string, any>;

    expect(res.turbopack.resolveAlias.modern).toBe('alias');
    expect(res.turbopack.resolveAlias['firebase/app']).toContain('/entries/app.');
    expect(res.turbo.resolveAlias.existing).toBe('alias');
    expect(res.turbo.resolveAlias['firebase/app']).toContain('/entries/app.');
    expect(res.experimental.turbo.resolveAlias.legacy).toBe('alias');
    expect(res.experimental.turbo.resolveAlias['firebase/firestore']).toContain('/entries/firestore.');
  });

  it('configures dev-time rewrites to proxy /__pyric/:path* to sandbox target url', async () => {
    const res = withPyric({}) as Record<string, any>;
    expect(typeof res.rewrites).toBe('function');
    const rewrites = await res.rewrites();
    expect(Array.isArray(rewrites)).toBe(true);
    expect(rewrites[0]).toEqual({
      source: '/__pyric/:path*',
      destination: 'http://127.0.0.1:4000/__pyric/:path*',
    });
  });

  it('respects port and url option overrides for dev-time rewrites', async () => {
    const res = withPyric({}, { port: 5555 }) as Record<string, any>;
    const rewrites = await res.rewrites();
    expect(rewrites[0].destination).toBe('http://127.0.0.1:5555/__pyric/:path*');

    const resUrl = withPyric({}, { url: 'http://custom-host:8080/' }) as Record<string, any>;
    const rewritesUrl = await resUrl.rewrites();
    expect(rewritesUrl[0].destination).toBe('http://custom-host:8080/__pyric/:path*');
  });

  it('wraps pre-existing user array rewrites and object rewrites (beforeFiles)', async () => {
    const userArrayRewrites = async () => [{ source: '/api/:path*', destination: '/custom/:path*' }];
    const resArray = withPyric({ rewrites: userArrayRewrites }) as Record<string, any>;
    const arrayResult = await resArray.rewrites();
    expect(arrayResult).toHaveLength(2);
    expect(arrayResult[0].source).toBe('/__pyric/:path*');
    expect(arrayResult[1].source).toBe('/api/:path*');

    const userObjRewrites = async () => ({
      beforeFiles: [{ source: '/before', destination: '/dest' }],
      afterFiles: [],
    });
    const resObj = withPyric({ rewrites: userObjRewrites }) as Record<string, any>;
    const objResult = await resObj.rewrites();
    expect(objResult.beforeFiles).toHaveLength(2);
    expect(objResult.beforeFiles[0].source).toBe('/__pyric/:path*');
    expect(objResult.beforeFiles[1].source).toBe('/before');
  });

  it('supports function-based Next.js configuration exports', async () => {
    const funcConfig = async (phase: string, defaults: any) => ({
      phase,
      defaults,
      reactStrictMode: true,
    });
    const res = withPyric(funcConfig as any);
    expect(typeof res).toBe('function');

    const evalResult = await (res as any)('phase-develop', { dev: true });
    expect(evalResult.phase).toBe('phase-develop');
    expect(evalResult.serverExternalPackages).toContain('firebase');
  });
});
