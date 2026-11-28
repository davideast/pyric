import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withPyric, type PyricNextOptions } from '../../src/next/index.js';
import {
  assertLocalFunctionsGatewayOrigin,
  isLoopbackOrPrivateOrigin,
  resolveFunctionsGateway,
} from '../../src/next/functions-target.js';
import { clearRegisterActive, markRegisterActive } from '../../src/register/activation.js';

const tempDirs: string[] = [];

function makeTempProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFunctionsProject(
  dir: string,
  options?: {
    projectId?: string;
    rewrites?: unknown[];
    built?: boolean;
  },
): void {
  const functionsDir = join(dir, 'functions');
  mkdirSync(functionsDir, { recursive: true });
  writeFileSync(join(functionsDir, 'package.json'), JSON.stringify({ name: 'test-fns', main: 'index.js' }));
  if (options?.built !== false) {
    writeFileSync(join(functionsDir, 'index.js'), 'exports.api = () => {};\n');
  }
  const firebaseJson: Record<string, unknown> = {
    functions: { source: 'functions' },
  };
  if (options?.rewrites !== undefined) {
    firebaseJson.hosting = { public: 'public', rewrites: options.rewrites };
  }
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(firebaseJson, null, 2));
  if (options?.projectId !== undefined) {
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: options.projectId } }));
  }
}

async function resolveWith(
  config: Record<string, unknown>,
  options?: PyricNextOptions,
  phase = 'phase-development-server',
): Promise<Record<string, any>> {
  const wrapped = withPyric(config, options);
  return wrapped(phase, {});
}

describe('Next.js withPyric Functions gateway & Hosting rewrites', () => {
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    PYRIC_SANDBOX: process.env.PYRIC_SANDBOX,
    PYRIC_SANDBOX_PORT: process.env.PYRIC_SANDBOX_PORT,
    PYRIC_SANDBOX_FORCE: process.env.PYRIC_SANDBOX_FORCE,
    PYRIC_FUNCTIONS_GATEWAY_URL: process.env.PYRIC_FUNCTIONS_GATEWAY_URL,
    PYRIC_PROJECT: process.env.PYRIC_PROJECT,
  };
  const savedCwd = process.cwd();

  beforeEach(() => {
    process.env.NODE_ENV = 'development';
    process.env.PYRIC_SANDBOX = 'remote:http://127.0.0.1:4000';
    markRegisterActive();
    delete process.env.PYRIC_SANDBOX_PORT;
    delete process.env.PYRIC_SANDBOX_FORCE;
    delete process.env.PYRIC_FUNCTIONS_GATEWAY_URL;
    delete process.env.PYRIC_PROJECT;
  });

  afterEach(() => {
    process.chdir(savedCwd);
    clearRegisterActive();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('loopback and private-origin guard', () => {
    it('accepts loopback and private-network origins (including ws/wss schemes)', () => {
      for (const allowed of [
        'http://127.0.0.1:4000',
        'http://127.0.0.2:3473/',
        'http://localhost:3473',
        'http://app.localhost:3473',
        'http://[::1]:4000',
        'ws://127.0.0.1:4000',
        'wss://localhost:4443',
        'http://10.0.0.5:4000',
        'http://172.16.10.2:4000',
        'http://192.168.1.50:4000',
        'http://100.64.0.10:4000',
        'http://[fd00::1]:4000',
      ]) {
        expect(isLoopbackOrPrivateOrigin(allowed), allowed).toBe(true);
      }
    });

    it('rejects public hosts, link-local IMDS, wildcards, credentials, non-root paths, and non-HTTP schemes', () => {
      for (const rejected of [
        '',
        'not-a-url',
        'https://us-central1-prod.cloudfunctions.net',
        'https://evil.example',
        'http://8.8.8.8:4000',
        'http://169.254.169.254',
        'http://169.254.0.1:4000',
        'http://[fe80::1]:4000',
        'http://0.0.0.0:4000',
        'http://[::]:4000',
        'http://user:pass@127.0.0.1:4000',
        'http://127.0.0.1:4000/subpath',
        'http://127.0.0.1:4000/?foo=1',
        'file:///etc/passwd',
        'ftp://127.0.0.1:21',
      ]) {
        expect(isLoopbackOrPrivateOrigin(rejected), rejected).toBe(false);
        expect(() => assertLocalFunctionsGatewayOrigin(rejected, 'test')).toThrow(/loopback or private-network/);
      }
    });

    it('throws when explicit options.functions.url or PYRIC_FUNCTIONS_GATEWAY_URL targets a public host', async () => {
      await expect(
        resolveWith({}, { functions: { url: 'https://evil.example' } }),
      ).rejects.toThrow(/options\.functions\.url must be a loopback or private-network/);

      process.env.PYRIC_FUNCTIONS_GATEWAY_URL = 'https://us-central1-prod.cloudfunctions.net';
      await expect(resolveWith({})).rejects.toThrow(/PYRIC_FUNCTIONS_GATEWAY_URL must be a loopback or private-network/);
    });

    it('fails closed with a warning on auto-detect when sandbox target url is non-loopback', () => {
      const dir = makeTempProject('pyric-next-fn-public-sandbox-');
      writeFunctionsProject(dir, {
        projectId: 'demo-proj',
        rewrites: [{ source: '/api/**', function: 'api' }],
      });
      const warnings: string[] = [];
      const resolved = resolveFunctionsGateway(
        { url: 'https://public-sandbox.example' },
        dir,
        (msg) => warnings.push(msg),
      );
      expect(resolved).toBeNull();
      expect(warnings.some((w) => w.includes('not a loopback or private-network origin'))).toBe(true);
    });
  });

  describe('safe fallback when no Functions gateway is active', () => {
    it('emits only /__pyric/:path* when no firebase.json exists', async () => {
      const dir = makeTempProject('pyric-next-no-fb-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      process.chdir(dir);

      const res = await resolveWith({});
      const rewrites = await res.rewrites();
      expect(rewrites).toEqual([
        {
          source: '/__pyric/:path*',
          destination: 'http://127.0.0.1:4000/__pyric/:path*',
          basePath: false,
        },
      ]);
      expect(res.env.NEXT_PUBLIC_PYRIC_FUNCTIONS_URL).toBeUndefined();
      expect(res.env.PYRIC_FUNCTIONS_GATEWAY_URL).toBeUndefined();
    });

    it('falls back safely when firebase.json has hosting function rewrites but no functions source', async () => {
      const dir = makeTempProject('pyric-next-no-fn-block-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      writeFileSync(
        join(dir, 'firebase.json'),
        JSON.stringify({
          hosting: { rewrites: [{ source: '/api/**', function: 'api' }] },
        }),
      );
      process.chdir(dir);

      const res = await resolveWith({});
      const rewrites = await res.rewrites();
      expect(Array.isArray(rewrites)).toBe(true);
      expect(rewrites).toHaveLength(1);
      expect(rewrites[0].source).toBe('/__pyric/:path*');
    });

    it('falls back safely when functions entry is not built yet or firebase.json is invalid', async () => {
      const dir = makeTempProject('pyric-next-unbuilt-fn-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      writeFunctionsProject(dir, {
        built: false,
        rewrites: [{ source: '/api/**', function: 'api' }],
      });
      const warnings: string[] = [];
      const resolved = resolveFunctionsGateway(undefined, dir, (w) => warnings.push(w));
      expect(resolved).toBeNull();

      const badDir = makeTempProject('pyric-next-bad-json-');
      writeFileSync(join(badDir, 'firebase.json'), '{ invalid json');
      const badWarnings: string[] = [];
      expect(resolveFunctionsGateway(undefined, badDir, (w) => badWarnings.push(w))).toBeNull();
      expect(badWarnings).toHaveLength(1);
    });

    it('disables Functions rewrites when options.functions === false or options.rewrites === false', async () => {
      const dir = makeTempProject('pyric-next-fn-optout-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      writeFunctionsProject(dir, {
        projectId: 'demo-proj',
        rewrites: [{ source: '/api/**', function: 'api' }],
      });
      process.chdir(dir);

      const fnDisabled = await resolveWith({}, { functions: false });
      const rewrites = await fnDisabled.rewrites();
      expect(rewrites).toEqual([
        {
          source: '/__pyric/:path*',
          destination: 'http://127.0.0.1:4000/__pyric/:path*',
          basePath: false,
        },
      ]);

      const allDisabled = await resolveWith({}, { rewrites: false });
      expect(allDisabled.rewrites).toBeUndefined();
    });
  });

  describe('rewrite wiring and merging with user-defined Next.js rewrites()', () => {
    it('wires /__pyric/functions/* ahead of /__pyric/*, emulator path, and Hosting rewrites with no user rewrites', async () => {
      const dir = makeTempProject('pyric-next-fn-auto-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      writeFunctionsProject(dir, {
        projectId: 'demo-proj',
        rewrites: [
          { source: '/api/**', function: 'api' },
          { source: '**', function: 'ssr' },
        ],
      });
      process.chdir(dir);

      const res = await resolveWith({});
      const rewrites = await res.rewrites();
      expect(rewrites).toEqual({
        beforeFiles: [
          {
            source: '/__pyric/functions/:path*',
            destination: 'http://127.0.0.1:4000/:path*',
            basePath: false,
          },
          {
            source: '/__pyric/:path*',
            destination: 'http://127.0.0.1:4000/__pyric/:path*',
            basePath: false,
          },
        ],
        afterFiles: [
          {
            source: '/demo-proj/:region([a-z]+-[a-z]+\\d+)/:fn/:path*',
            destination: 'http://127.0.0.1:4000/demo-proj/:region/:fn/:path*',
            basePath: false,
          },
          {
            source: '/api/:path*',
            destination: 'http://127.0.0.1:4000/api/:path*',
            basePath: false,
          },
        ],
        fallback: [
          {
            source: '/:path*',
            destination: 'http://127.0.0.1:4000/:path*',
            basePath: false,
          },
        ],
      });
      expect(res.env.NEXT_PUBLIC_PYRIC_FUNCTIONS_URL).toBe('/__pyric/functions');
      expect(res.env.PYRIC_FUNCTIONS_GATEWAY_URL).toBe('http://127.0.0.1:4000');
    });

    it('preserves user array rewrites in afterFiles ahead of Hosting function rewrites', async () => {
      const dir = makeTempProject('pyric-next-fn-array-merge-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      writeFunctionsProject(dir, {
        projectId: 'demo-proj',
        rewrites: [
          { source: '/api/**', function: 'api' },
          { source: '**', function: 'ssr' },
        ],
      });
      process.chdir(dir);

      const userRewrites = async () => [
        { source: '/api/local', destination: '/internal/local' },
        { source: '/docs/:slug*', destination: '/help/:slug*' },
      ];
      const res = await resolveWith({ rewrites: userRewrites });
      const rewrites = await res.rewrites();

      expect(rewrites.beforeFiles.map((r: { source: string }) => r.source)).toEqual([
        '/__pyric/functions/:path*',
        '/__pyric/:path*',
      ]);
      expect(rewrites.afterFiles.map((r: { source: string }) => r.source)).toEqual([
        '/api/local',
        '/docs/:slug*',
        '/demo-proj/:region([a-z]+-[a-z]+\\d+)/:fn/:path*',
        '/api/:path*',
      ]);
      expect(rewrites.fallback.map((r: { source: string }) => r.source)).toEqual(['/:path*']);
    });

    it('merges into user object rewrites (beforeFiles/afterFiles/fallback) and preserves extra properties', async () => {
      const dir = makeTempProject('pyric-next-fn-obj-merge-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      writeFunctionsProject(dir, {
        projectId: 'demo-proj',
        rewrites: [
          { source: '/api/**', function: 'api' },
          { source: '**', function: 'ssr' },
        ],
      });
      process.chdir(dir);

      const userRewrites = async () => ({
        beforeFiles: [{ source: '/early', destination: '/early-dest' }],
        afterFiles: [{ source: '/api/override', destination: '/next-api/override' }],
        fallback: [{ source: '/legacy/:path*', destination: '/archive/:path*' }],
        customMeta: 'preserved',
      });
      const res = await resolveWith({ rewrites: userRewrites });
      const rewrites = await res.rewrites();

      expect(rewrites.customMeta).toBe('preserved');
      expect(rewrites.beforeFiles.map((r: { source: string }) => r.source)).toEqual([
        '/__pyric/functions/:path*',
        '/__pyric/:path*',
        '/early',
      ]);
      expect(rewrites.afterFiles.map((r: { source: string }) => r.source)).toEqual([
        '/api/override',
        '/demo-proj/:region([a-z]+-[a-z]+\\d+)/:fn/:path*',
        '/api/:path*',
      ]);
      expect(rewrites.fallback.map((r: { source: string }) => r.source)).toEqual([
        '/legacy/:path*',
        '/:path*',
      ]);
    });

    it('handles partial user object rewrites (only fallback, or sync function returning object)', async () => {
      const dir = makeTempProject('pyric-next-fn-partial-obj-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      writeFunctionsProject(dir, {
        projectId: 'demo-proj',
        rewrites: [{ source: '/api/**', function: 'api' }],
      });
      process.chdir(dir);

      const res = await resolveWith({
        rewrites: () => ({
          fallback: [{ source: '/old', destination: '/new' }],
        }),
      });
      const rewrites = await res.rewrites();
      expect(rewrites.beforeFiles.map((r: { source: string }) => r.source)).toEqual([
        '/__pyric/functions/:path*',
        '/__pyric/:path*',
      ]);
      expect(rewrites.afterFiles.map((r: { source: string }) => r.source)).toEqual([
        '/demo-proj/:region([a-z]+-[a-z]+\\d+)/:fn/:path*',
        '/api/:path*',
      ]);
      expect(rewrites.fallback).toEqual([{ source: '/old', destination: '/new' }]);
    });

    it('respects basePath, i18n locale flags, separate functions port/url, and hostingRewrites: false', async () => {
      const dir = makeTempProject('pyric-next-fn-basepath-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      writeFunctionsProject(dir, {
        projectId: 'demo-proj',
        rewrites: [{ source: '/api/**', function: 'api' }],
      });
      process.chdir(dir);

      const res = await resolveWith(
        {
          basePath: '/app',
          i18n: { locales: ['en', 'fr'], defaultLocale: 'en' },
        },
        {
          port: 4000,
          functions: { port: 4501, hostingRewrites: false },
        },
      );
      const rewrites = await res.rewrites();
      expect(rewrites.beforeFiles).toEqual([
        {
          source: '/__pyric/functions/:path*',
          destination: 'http://127.0.0.1:4501/:path*',
          basePath: false,
          locale: false,
        },
        {
          source: '/__pyric/:path*',
          destination: 'http://127.0.0.1:4000/__pyric/:path*',
          basePath: false,
          locale: false,
        },
      ]);
      expect(rewrites.afterFiles).toEqual([
        {
          source: '/demo-proj/:region([a-z]+-[a-z]+\\d+)/:fn/:path*',
          destination: 'http://127.0.0.1:4501/demo-proj/:region/:fn/:path*',
          basePath: false,
          locale: false,
        },
      ]);
      expect(res.env.PYRIC_FUNCTIONS_GATEWAY_URL).toBe('http://127.0.0.1:4501');
    });

    it('supports explicit options.functions: true and PYRIC_FUNCTIONS_GATEWAY_URL without a functions dir', async () => {
      const dir = makeTempProject('pyric-next-fn-env-');
      writeFileSync(join(dir, 'next.config.mjs'), 'export default {};\n');
      process.chdir(dir);

      process.env.PYRIC_FUNCTIONS_GATEWAY_URL = 'http://127.0.0.1:4888/';
      const res = await resolveWith({});
      const rewrites = await res.rewrites();
      expect(rewrites.beforeFiles[0]).toEqual({
        source: '/__pyric/functions/:path*',
        destination: 'http://127.0.0.1:4888/:path*',
        basePath: false,
      });
      expect(rewrites.afterFiles).toEqual([]);
    });

    it('keeps production builds untouched even when firebase.json declares Functions', async () => {
      const dir = makeTempProject('pyric-next-fn-prod-');
      writeFunctionsProject(dir, {
        projectId: 'demo-proj',
        rewrites: [{ source: '/api/**', function: 'api' }],
      });
      process.chdir(dir);
      delete process.env.PYRIC_SANDBOX;

      const original = { reactStrictMode: true };
      const prod = await resolveWith(original, undefined, 'phase-production-build');
      expect(prod).toBe(original);
    });
  });
});
