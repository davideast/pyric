/**
 * #1637: `withPyric` adds the bridge import loader rules only in production
 * AI mode, and points them at the `firebase` of Next's project directory.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withPyric } from '../../../src/next/index.js';
import { BRIDGE_IMPORT_LOADER, bridgeImportRewrites, bridgeModuleFileNames, PyricNextBridgeError } from '../../../src/next/bridge-imports.js';

type Config = Record<string, any>;

const SAVED = ['PYRIC_SANDBOX', 'PYRIC_AI_MODE', 'PYRIC_AI_PASSTHROUGH', 'PYRIC_GUARD'] as const;
const CLI_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const temp = mkdtempSync(join(tmpdir(), 'pyric-1637-bridge-'));

async function devConfig(config: Config = {}): Promise<Config> {
  const wrapped = withPyric(config) as (phase: string, defaults: Config) => Promise<Config>;
  return wrapped('phase-development-server', {});
}

function clientWebpack(config: Config, dir = CLI_ROOT): Config {
  return config.webpack({ resolve: {}, module: { rules: ['user rule'] } }, { isServer: false, dir });
}

/** A fake `firebase` install whose app and app-check browser entries name `tag`. */
function fakeFirebase(dir: string, tag: string, exportsAppCheck = true): void {
  const exports: Record<string, unknown> = { './app': { browser: { import: `./app/${tag}.js` } } };
  if (exportsAppCheck) exports['./app-check'] = { browser: { import: `./app-check/${tag}.js` } };
  mkdirSync(join(dir, 'node_modules', 'firebase'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'firebase', 'package.json'), JSON.stringify({ name: 'firebase', exports }));
}

describe('withPyric bridge import rules', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of SAVED) saved[key] = process.env[key];
    process.env.PYRIC_SANDBOX = 'remote:http://127.0.0.1:4000';
    delete process.env.PYRIC_AI_MODE;
    delete process.env.PYRIC_AI_PASSTHROUGH;
  });

  afterEach(() => {
    for (const key of SAVED) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('leaves turbopack.rules and the webpack module section untouched in sandbox mode', async () => {
    const config = await devConfig({ turbopack: { rules: { '*.svg': { loaders: ['svg'] } } } });
    expect(config.turbopack.rules).toEqual({ '*.svg': { loaders: ['svg'] } });
    expect(clientWebpack(config).module).toEqual({ rules: ['user rule'] });
    const bare = await devConfig();
    expect(bare.turbopack.rules).toBeUndefined();
  });

  it('adds exactly the two Turbopack rules and one webpack rule in production AI mode', async () => {
    process.env.PYRIC_AI_MODE = 'production';
    const config = await devConfig({ turbopack: { rules: { '*.svg': { loaders: ['svg'] } } } });
    const names = bridgeModuleFileNames();
    expect(Object.keys(config.turbopack.rules).sort()).toEqual(['*.svg', ...names].sort());
    const options = bridgeImportRewrites(CLI_ROOT);
    for (const name of names) {
      expect(config.turbopack.rules[name]).toEqual({ loaders: [{ loader: BRIDGE_IMPORT_LOADER, options }], as: '*.js' });
    }
    const rules = clientWebpack(config).module.rules;
    expect(rules).toEqual(['user rule', { test: Object.keys(options!.rewrites), use: [{ loader: BRIDGE_IMPORT_LOADER, options }] }]);
  });
});

describe('bridge import rewrites in a monorepo', () => {
  afterAll(() => rmSync(temp, { recursive: true, force: true }));

  it("resolves the project directory's own firebase, not the working directory's", () => {
    const root = join(temp, 'repo');
    const web = join(root, 'apps', 'web');
    fakeFirebase(root, 'root');
    fakeFirebase(web, 'web');
    const targets = Object.values(bridgeImportRewrites(web)!.rewrites).map((rewrite) => rewrite.target);
    expect(targets).toHaveLength(2);
    for (const target of targets) expect(target).toMatch(/apps\/web\/node_modules\/firebase\/app(-check)?\/web\.js$/);
  });

  it('reads the project directory from the next.config that calls withPyric', async () => {
    const web = realpathSync(join(temp, 'repo', 'apps', 'web'));
    const configFile = join(web, 'next.config.mjs');
    const configDir = pathToFileURL(fileURLToPath(new URL('../../../src/next/config-dir.ts', import.meta.url))).href;
    writeFileSync(configFile, `import { callingConfigDir } from '${configDir}';\nexport const dir = callingConfigDir();\n`);
    const loaded = (await import(pathToFileURL(configFile).href)) as { dir: string };
    expect(realpathSync(loaded.dir)).toBe(web);
  });

  it('throws a named error when firebase exports no browser entry for a wrapper import', () => {
    const project = join(temp, 'no-app-check');
    fakeFirebase(project, 'x', false);
    expect(() => bridgeImportRewrites(project)).toThrow(PyricNextBridgeError);
  });
});
