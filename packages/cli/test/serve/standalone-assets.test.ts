/** The standalone-binary asset bridge (`src/serve/standalone-assets.ts`).
 *
 *  This is the one serve code path the rest of the suite never exercises: the
 *  `isStandalone()` branch only runs inside a `bun build --compile` binary,
 *  where the compile step installs `globalThis.__PYRIC_EMBEDDED__`. A refactor
 *  to the embed contract (serve.ts, the bundler, the namespace) can silently
 *  break the binary with nothing here to catch it -- these tests pin the runtime
 *  contract without compiling (no 100MB binary, no esbuild), so they ride the
 *  normal free `bun test`. The end-to-end "does bun actually embed it" check is
 *  scripts/standalone-smoke.ts against a real binary. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createPrivateJobTmpDir,
  removePrivateJobTmpDir,
} from '../../../../scripts/lib/private-job-tmpdir.ts';
import { embeddedAssetVersion } from '../../scripts/embedded-asset-version.js';
import * as standaloneAssets from '../../src/serve/standalone-assets.js';
import {
  assertStandaloneSupportsAiMode,
  embeddedWorkerVersion,
  isStandalone,
  materializeServeAssets,
  materializeSiteUi,
  resolveStandaloneServeCacheRoot,
  type EmbeddedAssets,
} from '../../src/serve/standalone-assets.js';
import {
  STANDALONE_SERVE_MARKER,
  evictStandaloneServeCache,
  isAllowlistedStandaloneServeRoot,
} from '../../src/serve/standalone-cache-evict.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const TEST_ROOT_MARKER = '.pyric-standalone-ut-root';

const VERSION = 'unit-test-0';
const ASSET_VERSION = 'assets-deadbeef';
const WORKER_V = 'wv-deadbeef';
const SDK_BLOB: Record<string, string> = {
  'app.js': b64('// pyric app shim'),
  'worker.js': b64('// worker'),
};
const SITE_BLOB: Record<string, string> = {
  'index.html': b64('<!doctype html>studio'),
  '_astro/app.js': b64('// unified site bundle'),
  'assets/nested/item.txt': b64('nested asset'),
  'studio-routes.json': b64('{"routes":[]}'),
};

function createAllowlistedTestRoot(suffix: string): string {
  const parent = join(homedir(), '.cache');
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, `pyric-ut-standalone-${suffix}-`));
  writeFileSync(join(dir, TEST_ROOT_MARKER), '1\n');
  return dir;
}

function removeAllowlistedTestRoot(dir: string): void {
  if (isAllowlistedStandaloneServeRoot(dir) === false) {
    return;
  }
  const st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined || st.isSymbolicLink() || st.isDirectory() === false) {
    return;
  }
  if (existsSync(join(dir, TEST_ROOT_MARKER)) === false) {
    return;
  }
  rmSync(dir, { recursive: true, force: true });
}

let testCacheRoot = '';
let expectedEntryRoot = '';
let savedCacheDirEnv: string | undefined;
let sdkCalls = 0;
let siteCalls = 0;

beforeAll(() => {
  savedCacheDirEnv = process.env.PYRIC_STANDALONE_SERVE_CACHE_DIR;
  testCacheRoot = createAllowlistedTestRoot('main');
  process.env.PYRIC_STANDALONE_SERVE_CACHE_DIR = testCacheRoot;
  expectedEntryRoot = join(testCacheRoot, `${VERSION}-${ASSET_VERSION}`);

  const embedded: EmbeddedAssets = {
    version: VERSION,
    assetVersion: ASSET_VERSION,
    workerVersion: WORKER_V,
    sdk: async () => {
      sdkCalls += 1;
      return { ...SDK_BLOB };
    },
    site: async () => {
      siteCalls += 1;
      return { ...SITE_BLOB };
    },
  };
  globalThis.__PYRIC_EMBEDDED__ = embedded;
});

afterAll(() => {
  globalThis.__PYRIC_EMBEDDED__ = undefined;
  if (savedCacheDirEnv === undefined) {
    delete process.env.PYRIC_STANDALONE_SERVE_CACHE_DIR;
  } else {
    process.env.PYRIC_STANDALONE_SERVE_CACHE_DIR = savedCacheDirEnv;
  }
  removeAllowlistedTestRoot(testCacheRoot);
});

describe('isStandalone', () => {
  it('reflects the presence of the embedded global', () => {
    expect(isStandalone()).toBe(true);
    const saved = globalThis.__PYRIC_EMBEDDED__;
    globalThis.__PYRIC_EMBEDDED__ = undefined;
    expect(isStandalone()).toBe(false);
    globalThis.__PYRIC_EMBEDDED__ = saved;
  });
});

describe('embeddedWorkerVersion', () => {
  it('returns the worker hash baked onto the global', () => {
    expect(embeddedWorkerVersion()).toBe(WORKER_V);
  });
});

describe('resolveStandaloneServeCacheRoot', () => {
  it('defaults to ~/.pyric/standalone-serve and refuses /tmp, tmpdir(), $HOME, ~/.pyric, ~/.cache, and sibling ~/.pyric subroots', () => {
    const defaultRoot = resolve(join(homedir(), '.pyric', 'standalone-serve'));
    expect(resolveStandaloneServeCacheRoot({})).toBe(defaultRoot);

    for (const forbidden of [
      '/tmp',
      tmpdir(),
      homedir(),
      join(homedir(), '.pyric'),
      join(homedir(), '.pyric', 'vite-worker'),
      join(homedir(), '.cache'),
    ]) {
      expect(
        resolveStandaloneServeCacheRoot({ PYRIC_STANDALONE_SERVE_CACHE_DIR: forbidden }),
      ).toBe(defaultRoot);
      expect(evictStandaloneServeCache(forbidden, 'keep', { maxEntries: 0, minAgeMs: 1 })).toEqual(
        [],
      );
    }

    expect(
      resolveStandaloneServeCacheRoot({ PYRIC_STANDALONE_SERVE_CACHE_DIR: testCacheRoot }),
    ).toBe(resolve(testCacheRoot));
  });
});

describe('materializeServeAssets', () => {
  it('derives a stable identity from every embedded asset tree', () => {
    const first = embeddedAssetVersion({ sdk: { 'app.js': 'first' }, site: {} });
    const reordered = embeddedAssetVersion({ site: {}, sdk: { 'app.js': 'first' } });
    const changed = embeddedAssetVersion({ sdk: { 'app.js': 'second' }, site: {} });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('decodes embedded SDK files under allowlisted cache root and stamps .pyric-standalone + sdk/.complete', async () => {
    const { outDir, cached } = await materializeServeAssets();
    expect(outDir).toBe(join(expectedEntryRoot, 'sdk'));
    expect(cached).toBe(false);
    for (const [name, blob] of Object.entries(SDK_BLOB)) {
      const onDisk = readFileSync(join(outDir, name));
      expect(onDisk.equals(Buffer.from(blob, 'base64'))).toBe(true);
    }
    expect(existsSync(join(expectedEntryRoot, STANDALONE_SERVE_MARKER))).toBe(true);
    expect(existsSync(join(outDir, '.complete'))).toBe(true);
  });

  it('is idempotent -- a second call reuses without re-decoding', async () => {
    const before = sdkCalls;
    const { outDir, cached } = await materializeServeAssets();
    expect(outDir).toBe(join(expectedEntryRoot, 'sdk'));
    expect(cached).toBe(true);
    expect(sdkCalls).toBe(before);
  });

  it('isolates same-version standalone rebuilds by embedded asset content and evicts expired marker-verified overflow entries', () => {
    const isoCacheRoot = createAllowlistedTestRoot('iso');
    const externalDir = createPrivateJobTmpDir('standalone-ext');
    mkdirSync(join(externalDir, 'sdk'), { recursive: true });
    writeFileSync(join(externalDir, STANDALONE_SERVE_MARKER), 'ext\n');
    writeFileSync(join(externalDir, 'sdk', '.complete'), 'ext');
    try {
      const staleAgeSecs = (Date.now() - 4 * 3_600_000) / 1000;
      const staleEntry = join(isoCacheRoot, 'old-0.0.1-aaaa');
      mkdirSync(join(staleEntry, 'sdk'), { recursive: true });
      writeFileSync(join(staleEntry, STANDALONE_SERVE_MARKER), '0.0.1\n');
      writeFileSync(join(staleEntry, 'sdk', '.complete'), '0.0.1');
      utimesSync(staleEntry, staleAgeSecs, staleAgeSecs);

      const unmarkedEntry = join(isoCacheRoot, 'unmarked-dir');
      mkdirSync(join(unmarkedEntry, 'sdk'), { recursive: true });
      writeFileSync(join(unmarkedEntry, 'sdk', '.complete'), '0.0.1');
      utimesSync(unmarkedEntry, staleAgeSecs, staleAgeSecs);

      const symlinkEntry = join(isoCacheRoot, 'symlink-entry');
      symlinkSync(externalDir, symlinkEntry);

      const version = `same-version-${String(process.pid)}`;
      const moduleUrl = pathToFileURL(
        resolve(import.meta.dir, '../../src/serve/standalone-assets.ts'),
      ).href;
      const runBuild = (assetVersion: string, appSource: string) => {
        const script = `
          globalThis.__PYRIC_EMBEDDED__ = {
            version: ${JSON.stringify(version)},
            assetVersion: ${JSON.stringify(assetVersion)},
            workerVersion: 'worker',
            sdk: async () => ({ 'app.js': Buffer.from(${JSON.stringify(appSource)}).toString('base64') }),
            site: async () => ({}),
          };
          const { materializeServeAssets } = await import(${JSON.stringify(moduleUrl)});
          const result = await materializeServeAssets();
          const source = await Bun.file(result.outDir + '/app.js').text();
          process.stdout.write(JSON.stringify({ ...result, source }));
        `;
        const result = Bun.spawnSync({
          cmd: [process.execPath, '-e', script],
          env: {
            ...process.env,
            PYRIC_STANDALONE_SERVE_CACHE_DIR: isoCacheRoot,
            PYRIC_STANDALONE_SERVE_MAX_ENTRIES: '1',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        expect(result.exitCode).toBe(0);
        return JSON.parse(result.stdout.toString()) as {
          outDir: string;
          cached: boolean;
          source: string;
        };
      };

      const first = runBuild('content-a', 'first build');
      const second = runBuild('content-b', 'second build');
      expect(first.cached).toBe(false);
      expect(second.cached).toBe(false);
      expect(first.outDir.startsWith(isoCacheRoot)).toBe(true);
      expect(second.outDir.startsWith(isoCacheRoot)).toBe(true);
      expect(second.outDir).not.toBe(first.outDir);
      expect(second.source).toBe('second build');

      // Expired marker-verified staleEntry is evicted; unmarked dir and symlink stay intact.
      expect(existsSync(staleEntry)).toBe(false);
      expect(existsSync(unmarkedEntry)).toBe(true);
      expect(lstatSync(symlinkEntry).isSymbolicLink()).toBe(true);
      expect(existsSync(externalDir)).toBe(true);
    } finally {
      removePrivateJobTmpDir(externalDir);
      removeAllowlistedTestRoot(isoCacheRoot);
    }
  });
});

describe('materializeSiteUi', () => {
  it('rebuilds the unified site tree, preserving nested relpaths', async () => {
    const dir = await materializeSiteUi();
    expect(dir).toBe(join(expectedEntryRoot, 'site-ui'));
    for (const [rel, blob] of Object.entries(SITE_BLOB)) {
      const onDisk = readFileSync(join(dir, rel));
      expect(onDisk.equals(Buffer.from(blob, 'base64'))).toBe(true);
    }
    expect(existsSync(join(dir, '_astro', 'app.js'))).toBe(true);
    expect(existsSync(join(dir, 'assets', 'nested', 'item.txt'))).toBe(true);
    expect(existsSync(join(expectedEntryRoot, STANDALONE_SERVE_MARKER))).toBe(true);
  });

  it('is idempotent across calls', async () => {
    const before = siteCalls;
    await materializeSiteUi();
    expect(siteCalls).toBe(before);
  });
});

describe('embedded() guard', () => {
  it('throws a clear error when assets are requested without the global', () => {
    const saved = globalThis.__PYRIC_EMBEDDED__;
    globalThis.__PYRIC_EMBEDDED__ = undefined;
    expect(() => embeddedWorkerVersion()).toThrow(/not a standalone build/);
    globalThis.__PYRIC_EMBEDDED__ = saved;
  });

  it('does not expose a separate pyricVersion fallback alongside cliVersion', () => {
    expect('pyricVersion' in standaloneAssets).toBe(false);
  });
});

describe('assertStandaloneSupportsAiMode (#1531)', () => {
  it('allows sandbox AI mode and refuses production AI mode naming @pyric/cli', async () => {
    expect(() => assertStandaloneSupportsAiMode('sandbox', {})).not.toThrow();

    expect(() =>
      assertStandaloneSupportsAiMode('production', { PYRIC_AI_MODE: 'production' }),
    ).toThrow(/PYRIC_AI_MODE=production.*@pyric\/cli/);

    expect(() =>
      assertStandaloneSupportsAiMode('production', { PYRIC_AI_PASSTHROUGH: '1' }),
    ).toThrow(/PYRIC_AI_PASSTHROUGH=1.*unset PYRIC_AI_PASSTHROUGH/);

    const beforeCalls = sdkCalls;
    await expect(
      materializeServeAssets({
        aiMode: 'production',
        env: { PYRIC_AI_MODE: 'production' },
      }),
    ).rejects.toThrow(/standalone pyric binary.*@pyric\/cli/);
    expect(sdkCalls).toBe(beforeCalls);

    const saved = globalThis.__PYRIC_EMBEDDED__;
    globalThis.__PYRIC_EMBEDDED__ = undefined;
    try {
      expect(() =>
        assertStandaloneSupportsAiMode('production', { PYRIC_AI_MODE: 'production' }),
      ).not.toThrow();
    } finally {
      globalThis.__PYRIC_EMBEDDED__ = saved;
    }
  });
});
