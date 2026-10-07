import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { withPyric } from '../../../src/next/index.js';

async function resolveWith(
  config: any,
  options?: any,
  phase = 'phase-development-server',
): Promise<Record<string, any>> {
  const wrapped = withPyric(config, options) as (phase: string, defaults: Record<string, any>) => Promise<Record<string, any>>;
  return wrapped(phase, {});
}

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

  it('acts as an identity passthrough in the production build phase without force', async () => {
    delete process.env.PYRIC_SANDBOX;
    const originalConfig = { reactStrictMode: true };
    for (const phase of ['phase-production-build', 'phase-production-server', 'phase-export']) {
      const res = await resolveWith(originalConfig, undefined, phase);
      expect(res).toBe(originalConfig);
    }
  });

  it('keys the decision on the Next phase, not NODE_ENV', async () => {
    // A shell that exports NODE_ENV=production still runs the development server phase with the sandbox.
    process.env.NODE_ENV = 'production';
    const dev = await resolveWith({ reactStrictMode: true }, undefined, 'phase-development-server');
    expect(dev.serverExternalPackages).toContain('firebase');

    // A development NODE_ENV does not make a production build use the sandbox.
    process.env.NODE_ENV = 'development';
    delete process.env.PYRIC_SANDBOX;
    const originalConfig = { reactStrictMode: true };
    const build = await resolveWith(originalConfig, undefined, 'phase-production-build');
    expect(build).toBe(originalConfig);
  });

  it('activates in a production phase when PYRIC_SANDBOX_FORCE=1 is set', async () => {
    process.env.PYRIC_SANDBOX_FORCE = '1';
    process.env.PYRIC_SANDBOX = 'local';
    const res = await resolveWith({ reactStrictMode: true }, undefined, 'phase-production-build');
    expect(res.serverExternalPackages).toContain('firebase');
    expect(res.serverExternalPackages).toContain('firebase-admin');
  });

  it('names only launch commands that the CLI dispatches', async () => {
    delete process.env.PYRIC_SANDBOX;
    let message = '';
    try {
      await resolveWith({});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('pyric sandbox -- next dev');
    expect(message).toContain('pyric sandbox --no-run');
    expect(message).not.toContain('pyric env');
  });

  it('returns a config function so the phase is known when the decision is made', () => {
    expect(typeof withPyric({})).toBe('function');
  });

  it('throws an error if PYRIC_SANDBOX is missing during the development server phase (bundler guard)', async () => {
    delete process.env.PYRIC_SANDBOX;
    await expect(resolveWith({})).rejects.toThrow(/Next\.js development server started without active Pyric sandbox/);
  });

  it('does not run the guard in a production build phase', async () => {
    delete process.env.PYRIC_SANDBOX;
    await expect(resolveWith({}, undefined, 'phase-production-build')).resolves.toEqual({});
  });

  it('allows execution when PYRIC_SANDBOX is missing if { guard: false } is passed', async () => {
    delete process.env.PYRIC_SANDBOX;
    const res = await resolveWith({}, { guard: false }) as Record<string, any>;
    expect(res.serverExternalPackages).toContain('firebase');
  });

  it('injects firebase and firebase-admin into serverExternalPackages with deduplication', async () => {
    const config = {
      serverExternalPackages: ['existing-pkg', 'firebase'],
      experimental: {
        serverComponentsExternalPackages: ['other-pkg', 'firebase-admin'],
      },
    };
    const res = await resolveWith(config) as Record<string, any>;
    expect(res.serverExternalPackages).toEqual(['existing-pkg', 'firebase', 'firebase-admin']);
    expect(res.experimental.serverComponentsExternalPackages).toEqual([
      'other-pkg',
      'firebase-admin',
      'firebase',
    ]);
  });

  it('configures client-side Webpack aliases and builtin fallbacks only for client builds (!isServer)', async () => {
    let calledWithConfig: any = null;
    const customWebpack = (cfg: any, options: any) => {
      calledWithConfig = cfg;
      cfg.customProperty = options.isServer ? 'server-build' : 'client-build';
      return cfg;
    };

    const res = await resolveWith({ webpack: customWebpack }) as Record<string, any>;
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
    expect(clientResult.resolve.alias['firebase/app$']).toBe('@pyric/cli/next/internal/app');
    expect(clientResult.resolve.alias['firebase/firestore$']).toBe('@pyric/cli/next/internal/firestore');
    // Webpack matches an alias key as a prefix unless it ends in `$`, so a
    // plain `firebase/firestore` key would also capture `firebase/firestore/lite`.
    expect(clientResult.resolve.alias['firebase/firestore/lite$']).toBe('@pyric/cli/next/internal/firestore-lite');
    expect(Object.keys(clientResult.resolve.alias).filter((key) => key.startsWith('firebase/') && !key.endsWith('$'))).toEqual([]);
    expect(clientResult.resolve.fallback.fs).toBe(false);
    expect(clientResult.resolve.fallback.path).toBe(false);
    expect(clientResult.experiments.topLevelAwait).toBe(true);
    expect(clientResult.output.environment.asyncFunction).toBe(true);
  });

  it('puts the React hook first in the client entries, before React evaluates', async () => {
    const res = await resolveWith({}) as Record<string, any>;
    const clientConfig: any = {
      entry: async () => ({
        'main-app': ['next/dist/client/app-next.js'],
        main: { import: ['next/dist/client/next.js'] },
        'app/page': ['./app/page.tsx'],
      }),
    };
    const clientResult = res.webpack(clientConfig, { isServer: false });
    const entries = await clientResult.entry();
    expect(entries['main-app']).toEqual(['@pyric/cli/next/internal/react-hook', 'next/dist/client/app-next.js']);
    expect(entries.main).toEqual({ import: ['@pyric/cli/next/internal/react-hook', 'next/dist/client/next.js'] });
    expect(entries['app/page']).toEqual(['./app/page.tsx']);
    // A second pass over the same entries does not add the hook twice.
    clientResult.entry = res.webpack({ entry: async () => entries }, { isServer: false }).entry;
    expect((await clientResult.entry())['main-app']).toEqual(['@pyric/cli/next/internal/react-hook', 'next/dist/client/app-next.js']);

    const serverResult = res.webpack({ entry: async () => ({ 'main-app': ['server.js'] }) }, { isServer: true });
    expect((await serverResult.entry())['main-app']).toEqual(['server.js']);
  });

  it('installs the React hook when its entry evaluates, and keeps an existing one', async () => {
    const host = globalThis as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown };
    const previous = host.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    delete host.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    try {
      await import('../../../src/next/react-hook-entry.ts?install=1');
      const hook = host.__REACT_DEVTOOLS_GLOBAL_HOOK__ as { supportsFiber?: boolean; inject?: unknown };
      expect(hook.supportsFiber).toBe(true);
      expect(typeof hook.inject).toBe('function');
      await import('../../../src/next/react-hook-entry.ts?install=2');
      expect(host.__REACT_DEVTOOLS_GLOBAL_HOOK__).toBe(hook);
    } finally {
      host.__REACT_DEVTOOLS_GLOBAL_HOOK__ = previous;
      if (previous === undefined) delete host.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    }
  });

  it('configures Turbopack aliases for client SDKs', async () => {
    const res = await resolveWith({
      turbopack: { resolveAlias: { modern: 'alias' } },
      turbo: { resolveAlias: { existing: 'alias' } },
      experimental: { turbo: { resolveAlias: { legacy: 'alias' } } },
    }) as Record<string, any>;

    expect(res.turbopack.resolveAlias.modern).toBe('alias');
    expect(res.turbopack.resolveAlias['firebase/app']).toBe('@pyric/cli/next/internal/app');
    expect(res.turbo.resolveAlias.existing).toBe('alias');
    expect(res.turbo.resolveAlias['firebase/app']).toBe('@pyric/cli/next/internal/app');
    expect(res.experimental.turbo.resolveAlias.legacy).toBe('alias');
    expect(res.experimental.turbo.resolveAlias['firebase/firestore']).toBe('@pyric/cli/next/internal/firestore');
  });

  it('configures dev-time rewrites to proxy /__pyric/:path* to sandbox target url', async () => {
    const res = await resolveWith({}) as Record<string, any>;
    expect(typeof res.rewrites).toBe('function');
    const rewrites = await res.rewrites();
    expect(Array.isArray(rewrites)).toBe(true);
    expect(rewrites[0]).toEqual({
      source: '/__pyric/:path*',
      destination: 'http://127.0.0.1:4000/__pyric/:path*',
      basePath: false,
    });
  });

  it('marks the Pyric rewrite basePath: false so a configured basePath does not prefix the source', async () => {
    const res = await resolveWith({ basePath: '/app' });
    const rewrites = await res.rewrites();
    expect(rewrites[0]).toEqual({
      source: '/__pyric/:path*',
      destination: 'http://127.0.0.1:4000/__pyric/:path*',
      basePath: false,
    });
  });

  it('respects port and url option overrides for dev-time rewrites', async () => {
    const res = await resolveWith({}, { port: 5555 }) as Record<string, any>;
    const rewrites = await res.rewrites();
    expect(rewrites[0].destination).toBe('http://127.0.0.1:5555/__pyric/:path*');

    const resUrl = await resolveWith({}, { url: 'http://custom-host:8080/' }) as Record<string, any>;
    const rewritesUrl = await resUrl.rewrites();
    expect(rewritesUrl[0].destination).toBe('http://custom-host:8080/__pyric/:path*');
  });

  it('wraps pre-existing user array rewrites and object rewrites (beforeFiles)', async () => {
    const userArrayRewrites = async () => [{ source: '/api/:path*', destination: '/custom/:path*' }];
    const resArray = await resolveWith({ rewrites: userArrayRewrites }) as Record<string, any>;
    const arrayResult = await resArray.rewrites();
    expect(arrayResult).toHaveLength(2);
    expect(arrayResult[0].source).toBe('/__pyric/:path*');
    expect(arrayResult[1].source).toBe('/api/:path*');

    const userObjRewrites = async () => ({
      beforeFiles: [{ source: '/before', destination: '/dest' }],
      afterFiles: [],
    });
    const resObj = await resolveWith({ rewrites: userObjRewrites }) as Record<string, any>;
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
    const evalResult = await resolveWith(funcConfig, undefined, 'phase-development-server');
    expect(evalResult.phase).toBe('phase-development-server');
    expect(evalResult.serverExternalPackages).toContain('firebase');

    const productionResult = await resolveWith(funcConfig, undefined, 'phase-production-build');
    expect(productionResult.phase).toBe('phase-production-build');
    expect(productionResult.serverExternalPackages).toBeUndefined();
  });

  it('configures PYRIC_RUNTIME_CHIP environment variables when runtimeChip option is passed', async () => {
    const resOff = await resolveWith({}, { runtimeChip: false }) as Record<string, any>;
    expect(resOff.env?.PYRIC_RUNTIME_CHIP).toBe('off');

    const resOpen = await resolveWith({}, { runtimeChip: { initiallyOpen: true } }) as Record<string, any>;
    expect(resOpen.env?.PYRIC_RUNTIME_CHIP).toBe('expanded');
  });

  it('also configures the NEXT_PUBLIC_-prefixed runtime chip variable so browser client components can read it', async () => {
    const resOff = await resolveWith({}, { runtimeChip: false }) as Record<string, any>;
    expect(resOff.env?.NEXT_PUBLIC_PYRIC_RUNTIME_CHIP).toBe('off');

    const resOpen = await resolveWith({}, { runtimeChip: { initiallyOpen: true } }) as Record<string, any>;
    expect(resOpen.env?.NEXT_PUBLIC_PYRIC_RUNTIME_CHIP).toBe('expanded');
  });

  it('configures NEXT_PUBLIC_PYRIC_STUDIO_URL matching the resolved sandbox target URL', async () => {
    const resDefault = await resolveWith({}) as Record<string, any>;
    expect(resDefault.env?.NEXT_PUBLIC_PYRIC_STUDIO_URL).toBe('http://127.0.0.1:4000/__pyric/ui/studio');
    expect(resDefault.env?.PYRIC_STUDIO_URL).toBe('http://127.0.0.1:4000/__pyric/ui/studio');

    const resPort = await resolveWith({}, { port: 3473 }) as Record<string, any>;
    expect(resPort.env?.NEXT_PUBLIC_PYRIC_STUDIO_URL).toBe('http://127.0.0.1:3473/__pyric/ui/studio');

    const resUrl = await resolveWith({}, { url: 'http://localhost:3473' }) as Record<string, any>;
    expect(resUrl.env?.NEXT_PUBLIC_PYRIC_STUDIO_URL).toBe('http://localhost:3473/__pyric/ui/studio');
  });
});
