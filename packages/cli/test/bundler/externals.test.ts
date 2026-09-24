import { afterAll, beforeAll, describe, expect, it, test } from 'bun:test';
import * as esbuild from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RollupOutput } from 'rollup';
import { build as viteBuildApi, type InlineConfig, type PluginOption } from 'vite';
import {
  isPyricExternal,
  pyricEsbuildExternals,
  pyricExternalPackages,
  pyricExternals,
  pyricRollupExternals,
  pyricViteExternals,
} from '../../src/bundler/externals.js';

describe('bundler externalization presets and predicate', () => {
  describe('isPyricExternal', () => {
    test('returns true for firebase-admin root and subpaths', () => {
      expect(isPyricExternal('firebase-admin')).toBe(true);
      expect(isPyricExternal('firebase-admin/app')).toBe(true);
      expect(isPyricExternal('firebase-admin/firestore')).toBe(true);
      expect(isPyricExternal('firebase-admin/auth')).toBe(true);
      expect(isPyricExternal('firebase-admin/database')).toBe(true);
      expect(isPyricExternal('firebase-admin/messaging')).toBe(true);
    });

    test('returns true for firebase client root and subpaths', () => {
      expect(isPyricExternal('firebase')).toBe(true);
      expect(isPyricExternal('firebase/app')).toBe(true);
      expect(isPyricExternal('firebase/firestore')).toBe(true);
      expect(isPyricExternal('firebase/auth')).toBe(true);
      expect(isPyricExternal('firebase/database')).toBe(true);
      expect(isPyricExternal('firebase/storage')).toBe(true);
    });

    test('returns true for @firebase scoped packages', () => {
      expect(isPyricExternal('@firebase/app')).toBe(true);
      expect(isPyricExternal('@firebase/firestore')).toBe(true);
      expect(isPyricExternal('@firebase/util')).toBe(true);
    });

    test('returns false for third-party libraries', () => {
      expect(isPyricExternal('express')).toBe(false);
      expect(isPyricExternal('hono')).toBe(false);
      expect(isPyricExternal('pg')).toBe(false);
      expect(isPyricExternal('dotenv')).toBe(false);
      expect(isPyricExternal('lodash')).toBe(false);
    });

    test('returns false for unrelated google cloud libraries', () => {
      expect(isPyricExternal('@google-cloud/storage')).toBe(false);
      expect(isPyricExternal('@google-cloud/firestore')).toBe(false);
      expect(isPyricExternal('@google/genai')).toBe(false);
    });

    test('returns false for partial name overlaps', () => {
      expect(isPyricExternal('firebase-tools')).toBe(false);
      expect(isPyricExternal('firebase-mock')).toBe(false);
      expect(isPyricExternal('my-firebase-app')).toBe(false);
    });

    test('returns false for empty or non-string inputs', () => {
      expect(isPyricExternal('')).toBe(false);
      expect(isPyricExternal(null as unknown as string)).toBe(false);
      expect(isPyricExternal(undefined as unknown as string)).toBe(false);
    });
  });

  describe('pyricRollupExternals', () => {
    test('matches firebase-admin, firebase, and @firebase packages', () => {
      const matchesAny = (id: string): boolean =>
        pyricRollupExternals.some((regex) => regex.test(id));

      expect(matchesAny('firebase-admin')).toBe(true);
      expect(matchesAny('firebase-admin/firestore')).toBe(true);
      expect(matchesAny('firebase')).toBe(true);
      expect(matchesAny('firebase/app')).toBe(true);
      expect(matchesAny('@firebase/app')).toBe(true);
    });

    test('rejects unrelated packages and partial overlaps', () => {
      const matchesAny = (id: string): boolean =>
        pyricRollupExternals.some((regex) => regex.test(id));

      expect(matchesAny('express')).toBe(false);
      expect(matchesAny('firebase-tools')).toBe(false);
      expect(matchesAny('@google-cloud/storage')).toBe(false);
    });
  });

  describe('pyricEsbuildExternals', () => {
    test('contains expected root and wildcard patterns for esbuild/tsup', () => {
      expect(pyricEsbuildExternals).toContain('firebase-admin');
      expect(pyricEsbuildExternals).toContain('firebase-admin/*');
      expect(pyricEsbuildExternals).toContain('firebase');
      expect(pyricEsbuildExternals).toContain('firebase/*');
      expect(pyricEsbuildExternals).toContain('@firebase/*');
    });
  });

  describe('pyricExternalPackages', () => {
    test('names the two packages @pyric/cli/register rewrites', () => {
      expect([...pyricExternalPackages]).toEqual(['firebase-admin', 'firebase']);
    });
  });

  describe('pyricViteExternals', () => {
    test('is a build-only Vite plugin with no hooks beyond config', () => {
      const plugin = pyricViteExternals();
      expect(Object.keys(plugin).sort()).toEqual(['apply', 'config', 'name']);
      expect(plugin.apply).toBe('build');
    });

    test('adds the package names to ssr.external', () => {
      const config = pyricViteExternals().config as (c: object) => unknown;
      expect(config({})).toEqual({ ssr: { external: ['firebase-admin', 'firebase'] } });
    });

    test('adds nothing when ssr.external already externalizes every dependency', () => {
      const config = pyricViteExternals().config as (c: object) => unknown;
      expect(config({ ssr: { external: true } })).toBeUndefined();
    });
  });

  describe('pyricExternals presets', () => {
    test('maps bundler aliases to their supported pattern formats', () => {
      expect(pyricExternals.rolldown).toBe(pyricRollupExternals);
      expect(pyricExternals.rollup).toBe(pyricRollupExternals);
      expect(pyricExternals.vite).toBe(pyricRollupExternals);
      expect(pyricExternals.webpack).toBe(pyricRollupExternals);
      expect(pyricExternals.esbuild).toBe(pyricEsbuildExternals);
      expect(pyricExternals.tsup).toBe(pyricEsbuildExternals);
    });
  });
});

/**
 * The presets against the bundlers themselves. The fixture project installs
 * stand-in `firebase-admin`, `firebase`, and `@firebase/util` packages whose
 * code carries a marker string, next to an ordinary dependency. A kept
 * external leaves an import of the specifier in the output; an inlined package
 * leaves its marker.
 */
describe('the presets in real bundlers', () => {
  let projectDir: string;

  const inlinedMarkers = {
    'firebase-admin/app': 'FIREBASE_ADMIN_INLINED',
    'firebase/firestore': 'FIREBASE_INLINED',
    '@firebase/util': 'FIREBASE_SCOPE_INLINED',
  } as const;
  const LOCAL_DEP_MARKER = 'LOCAL_DEP_INLINED';

  function writePackage(name: string, files: Record<string, string>, exportsMap: Record<string, string>): void {
    const dir = join(projectDir, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, type: 'module', exports: exportsMap }));
    for (const [file, source] of Object.entries(files)) writeFileSync(join(dir, file), source);
  }

  beforeAll(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'pyric-bundler-externals-'));
    writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }));
    writePackage(
      'firebase-admin',
      { 'app.js': `export const adminApp = '${inlinedMarkers['firebase-admin/app']}';\n` },
      { './app': './app.js' },
    );
    writePackage(
      'firebase',
      { 'firestore.js': `export const firestore = '${inlinedMarkers['firebase/firestore']}';\n` },
      { './firestore': './firestore.js' },
    );
    writePackage(
      '@firebase/util',
      { 'index.js': `export const util = '${inlinedMarkers['@firebase/util']}';\n` },
      { '.': './index.js' },
    );
    writePackage('local-dep', { 'index.js': `export const local = '${LOCAL_DEP_MARKER}';\n` }, { '.': './index.js' });
    mkdirSync(join(projectDir, 'src'));
    writeFileSync(
      join(projectDir, 'src', 'server.js'),
      `import { adminApp } from 'firebase-admin/app';
import { firestore } from 'firebase/firestore';
import { util } from '@firebase/util';
import { local } from 'local-dep';
console.log(adminApp, firestore, util, local);
`,
    );
    writeFileSync(
      join(projectDir, 'src', 'client.js'),
      `import { firestore } from 'firebase/firestore';
console.log(firestore);
`,
    );
  });

  afterAll(() => {
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  function expectFirebaseKeptExternal(code: string): void {
    for (const [specifier, marker] of Object.entries(inlinedMarkers)) {
      expect(code).toContain(`"${specifier}"`);
      expect(code).not.toContain(marker);
    }
    expect(code).toContain(LOCAL_DEP_MARKER);
  }

  async function esbuildBundle(external: string[]): Promise<string> {
    const result = await esbuild.build({
      absWorkingDir: projectDir,
      entryPoints: ['src/server.js'],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      logLevel: 'silent',
      external,
    });
    return result.outputFiles[0]!.text;
  }

  it('esbuild keeps every Firebase specifier external with pyricEsbuildExternals', async () => {
    expectFirebaseKeptExternal(await esbuildBundle([...pyricEsbuildExternals]));
  });

  it('esbuild inlines the stand-in packages without the preset (control)', async () => {
    const code = await esbuildBundle([]);
    for (const marker of Object.values(inlinedMarkers)) expect(code).toContain(marker);
  });

  /** A Vite build of `input`, returning the emitted entry chunk's code. */
  async function viteBuild(options: {
    input: string;
    ssr: boolean;
    plugins?: PluginOption[];
    rollupExternal?: RegExp[];
  }): Promise<string> {
    const buildOptions: InlineConfig['build'] = {
      write: false,
      minify: false,
      rollupOptions: { input: join(projectDir, options.input), external: options.rollupExternal },
    };
    if (options.ssr) buildOptions.ssr = options.input;
    const config: InlineConfig = {
      root: projectDir,
      configFile: false,
      envFile: false,
      logLevel: 'silent',
      plugins: options.plugins ?? [],
      // Bundle every dependency into the server output, the setting that
      // single-file Node deployments use.
      ssr: { noExternal: true },
      build: buildOptions,
    };
    const output = (await viteBuildApi(config)) as RollupOutput | RollupOutput[];
    const outputs = Array.isArray(output) ? output : [output];
    const chunk = outputs[0]!.output.find((item) => item.type === 'chunk' && item.isEntry);
    return (chunk as { code: string }).code;
  }

  it('Vite keeps Firebase external in an SSR build with ssr.noExternal: true', async () => {
    const code = await viteBuild({ input: 'src/server.js', ssr: true, plugins: [pyricViteExternals()] });
    for (const packageName of pyricExternalPackages) expect(code).toMatch(new RegExp(`"${packageName}/`));
    expect(code).not.toContain(inlinedMarkers['firebase-admin/app']);
    expect(code).not.toContain(inlinedMarkers['firebase/firestore']);
    expect(code).toContain(LOCAL_DEP_MARKER);
  });

  it('Vite inlines Firebase in the same SSR build without the plugin (control)', async () => {
    const code = await viteBuild({ input: 'src/server.js', ssr: true });
    expect(code).toContain(inlinedMarkers['firebase-admin/app']);
    expect(code).toContain(inlinedMarkers['firebase/firestore']);
  });

  it('Vite leaves a client build alone: the browser bundle still inlines firebase', async () => {
    const code = await viteBuild({ input: 'src/client.js', ssr: false, plugins: [pyricViteExternals()] });
    expect(code).toContain(inlinedMarkers['firebase/firestore']);
    expect(code).not.toContain('"firebase/firestore"');
  });

  it("Rollup, through Vite's build, keeps every Firebase specifier external with pyricRollupExternals", async () => {
    const code = await viteBuild({
      input: 'src/server.js',
      ssr: true,
      rollupExternal: [...pyricRollupExternals],
    });
    expectFirebaseKeptExternal(code);
  });
});
