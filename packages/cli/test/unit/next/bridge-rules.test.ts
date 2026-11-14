/**
 * #1637: `withPyric` adds the bridge import loader rules only in production
 * AI mode, and the loader points the wrappers at the `firebase` of the
 * project root the bundler gives it.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withPyric } from '../../../src/next/index.js';
import { markRegisterActive } from '../../../src/register/activation.js';
import { BRIDGE_IMPORT_LOADER, bridgeImportOptions, bridgeModuleFileNames, PyricNextBridgeError } from '../../../src/next/bridge-imports.js';
import bridgeImportLoader from '../../../src/next/bridge-import-loader.js';

type Config = Record<string, any>;

const REGISTER_ACTIVE = Symbol.for('pyric.register.active');
const SAVED = ['PYRIC_SANDBOX', 'PYRIC_AI_MODE', 'PYRIC_AI_PASSTHROUGH'] as const;
const temp = mkdtempSync(join(tmpdir(), 'pyric-1637-bridge-'));

async function devConfig(config: Config = {}): Promise<Config> {
  const wrapped = withPyric(config) as (phase: string, defaults: Config) => Promise<Config>;
  return wrapped('phase-development-server', {});
}

function clientWebpack(config: Config): Config {
  return config.webpack({ resolve: {}, module: { rules: ['user rule'] } }, { isServer: false });
}

/** A fake `firebase` install whose app and app-check browser entries name `tag`. */
function fakeFirebase(dir: string, tag: string, exportsAppCheck = true): void {
  const exports: Record<string, unknown> = { './app': { browser: { import: `./app/${tag}.js` } } };
  if (exportsAppCheck) exports['./app-check'] = { browser: { import: `./app-check/${tag}.js` } };
  mkdirSync(join(dir, 'node_modules', 'firebase'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'firebase', 'package.json'), JSON.stringify({ name: 'firebase', exports }));
}

/** Runs the loader on one wrapper with the project root a bundler would give. */
function load(wrapper: string, rootContext: string | undefined, source = readFileSync(wrapper, 'utf8')): string {
  return bridgeImportLoader.call({ resourcePath: wrapper, rootContext, getOptions: () => bridgeImportOptions() }, source);
}

const wrappers = Object.entries(bridgeImportOptions().wrappers);

describe('withPyric bridge import rules', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SAVED) saved[key] = process.env[key];
    process.env.PYRIC_SANDBOX = 'remote:http://127.0.0.1:4000';
    delete process.env.PYRIC_AI_MODE;
    delete process.env.PYRIC_AI_PASSTHROUGH;
    markRegisterActive();
  });

  afterEach(() => {
    for (const key of SAVED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete (globalThis as Record<symbol, unknown>)[REGISTER_ACTIVE];
  });

  it('leaves turbopack.rules and the webpack module section untouched in sandbox mode', async () => {
    const config = await devConfig({ turbopack: { rules: { '*.svg': { loaders: ['svg'] } } } });
    expect(config.turbopack.rules).toEqual({ '*.svg': { loaders: ['svg'] } });
    expect(clientWebpack(config).module).toEqual({ rules: ['user rule'] });
    const bare = await devConfig();
    expect(bare.turbopack.rules).toBeUndefined();
  });

  it('adds the Turbopack rules and one webpack rule in production AI mode', async () => {
    process.env.PYRIC_AI_MODE = 'production';
    const config = await devConfig({ turbopack: { rules: { '*.svg': { loaders: ['svg'] } } } });
    const names = bridgeModuleFileNames();
    expect(names).toContain('index.esm.js');
    expect(Object.keys(config.turbopack.rules).sort()).toEqual(['*.svg', ...names].sort());
    const options = bridgeImportOptions();
    for (const name of names) {
      expect(config.turbopack.rules[name]).toEqual({ loaders: [{ loader: BRIDGE_IMPORT_LOADER, options }], as: '*.js' });
    }
    const rules = clientWebpack(config).module.rules;
    expect(rules).toHaveLength(2);
    expect(rules[0]).toBe('user rule');
    expect(rules[1]).toMatchObject({ use: [{ loader: BRIDGE_IMPORT_LOADER, options }] });
  });
});

describe('the bridge import loader resolves firebase from the project root', () => {
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it('names both wrappers and only the specifiers the shared bypass names', () => {
    expect(wrappers.map(([, specifier]) => specifier).sort()).toEqual(['firebase/app', 'firebase/app-check']);
  });

  it("uses the app's own firebase when withPyric is called from a shared config package", () => {
    // apps/web/next.config.mjs imports packages/next-config, which calls withPyric.
    // Only apps/web has firebase (pnpm), while the repo root holds another copy (hoisted elsewhere).
    const root = join(temp, 'shared-wrapper');
    const web = join(root, 'apps', 'web');
    mkdirSync(join(root, 'packages', 'next-config'), { recursive: true });
    fakeFirebase(root, 'root');
    fakeFirebase(web, 'web');
    for (const [wrapper, specifier] of wrappers) {
      const loaded = load(wrapper, web);
      const target = loaded.match(new RegExp(`from '([^']+/${specifier.slice('firebase/'.length)}/web\\.js)'`))?.[1];
      expect(target, loaded.slice(0, 400)).toBeDefined();
      expect(fileURLToPath(new URL(target!, pathToFileURL(wrapper)))).toBe(join(web, 'node_modules', 'firebase', specifier.slice('firebase/'.length), 'web.js'));
    }
  });

  it('throws a named error naming the directory it searched when no firebase resolves', () => {
    const project = join(temp, 'no-firebase', 'apps', 'web');
    mkdirSync(project, { recursive: true });
    const [wrapper] = wrappers[0]!;
    expect(() => load(wrapper, project)).toThrow(PyricNextBridgeError);
    expect(() => load(wrapper, project)).toThrow(project);
  });

  it('throws a named error when firebase exports no browser entry for a wrapper import', () => {
    const project = join(temp, 'no-app-check');
    fakeFirebase(project, 'x', false);
    const appCheck = wrappers.find(([, specifier]) => specifier === 'firebase/app-check')![0];
    expect(() => load(appCheck, project)).toThrow(PyricNextBridgeError);
  });

  it('throws when the bundler gives no project root', () => {
    const [wrapper] = wrappers[0]!;
    expect(() => load(wrapper, undefined)).toThrow(PyricNextBridgeError);
  });

  it('throws for a named wrapper whose import it cannot rewrite', () => {
    const project = join(temp, 'rewrite-miss');
    fakeFirebase(project, 'x');
    const [wrapper] = wrappers[0]!;
    expect(() => load(wrapper, project, "const realApp = require('firebase/app');\n")).toThrow(PyricNextBridgeError);
  });

  it('leaves any other file unchanged', () => {
    const source = "import * as realApp from 'firebase/app';\n";
    expect(load('/project/src/register/app-bridge-shadow.js', '/project', source)).toBe(source);
    const appIndexSource = "import { initializeApp } from '@firebase/app';\n";
    expect(load('/project/src/lib/index.esm.js', '/project', appIndexSource)).toBe(appIndexSource);
  });

  it('rewrites internal @firebase/* imports inside real firebase/ai and @firebase/ai browser entries so they escape app-facing @firebase/* stops', () => {
    const project = join(temp, 'prod-ai-closure');
    fakeFirebase(project, 'browser');
    mkdirSync(join(project, 'node_modules', 'firebase', 'ai', 'dist', 'esm'), { recursive: true });
    writeFileSync(
      join(project, 'node_modules', 'firebase', 'package.json'),
      JSON.stringify({
        name: 'firebase',
        exports: {
          './app': { browser: { import: './app/browser.js' } },
          './app-check': { browser: { import: './app-check/browser.js' } },
          './ai': { browser: { import: './ai/dist/esm/index.esm.js' } },
        },
      }),
    );
    for (const scoped of ['@firebase/ai', '@firebase/app', '@firebase/component']) {
      const pkgDir = join(project, 'node_modules', scoped);
      mkdirSync(join(pkgDir, 'dist', 'esm'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: scoped,
          exports: { '.': { browser: { import: './dist/esm/index.esm.js' } } },
        }),
      );
      writeFileSync(join(pkgDir, 'dist', 'esm', 'index.esm.js'), 'export const ok = true;\n');
    }
    const firebaseAiEntry = join(project, 'node_modules', 'firebase', 'ai', 'dist', 'esm', 'index.esm.js');
    writeFileSync(firebaseAiEntry, "export * from '@firebase/ai';\n");
    const rewrittenFirebaseAi = load(firebaseAiEntry, project);
    expect(rewrittenFirebaseAi).not.toContain("'@firebase/ai'");
    expect(rewrittenFirebaseAi).toContain('@firebase/ai/dist/esm/index.esm.js');

    const scopedAiEntry = join(project, 'node_modules', '@firebase', 'ai', 'dist', 'esm', 'index.esm.js');
    const rewrittenScopedAi = load(
      scopedAiEntry,
      project,
      "import { _registerComponent } from '@firebase/app';\nimport { Component } from '@firebase/component';\n",
    );
    expect(rewrittenScopedAi).not.toContain("'@firebase/app'");
    expect(rewrittenScopedAi).not.toContain("'@firebase/component'");
    const specifiers = [...rewrittenScopedAi.matchAll(/from '([^']+)'/g)].map((match) =>
      resolve(dirname(scopedAiEntry), match[1]!),
    );
    expect(specifiers).toEqual([
      join(project, 'node_modules', '@firebase', 'app', 'dist', 'esm', 'index.esm.js'),
      join(project, 'node_modules', '@firebase', 'component', 'dist', 'esm', 'index.esm.js'),
    ]);
  });
});
