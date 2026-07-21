/** The standalone-binary asset bridge (`src/serve/standalone-assets.ts`).
 *
 *  This is the one serve code path the rest of the suite never exercises: the
 *  `isStandalone()` branch only runs inside a `bun build --compile` binary,
 *  where the compile step installs `globalThis.__PYRIC_EMBEDDED__`. A refactor
 *  to the embed contract (serve.ts, the bundler, the namespace) can silently
 *  break the binary with nothing here to catch it — these tests pin the runtime
 *  contract without compiling (no 100MB binary, no esbuild), so they ride the
 *  normal free `bun test`. The end-to-end "does bun actually embed it" check is
 *  scripts/standalone-smoke.ts against a real binary. */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  embeddedWorkerVersion,
  isStandalone,
  materializeServeAssets,
  materializeSiteUi,
  type EmbeddedAssets,
} from '../../src/serve/standalone-assets.js';
import { embeddedAssetVersion } from '../../scripts/embedded-asset-version.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

const VERSION = 'unit-test-0';
const ASSET_VERSION = 'assets-deadbeef';
const WORKER_V = 'wv-deadbeef';
const SDK_BLOB: Record<string, string> = { 'app.js': b64('// pyric app shim'), 'worker.js': b64('// worker') };
const SITE_BLOB: Record<string, string> = {
  'index.html': b64('<!doctype html>studio'),
  '_astro/app.js': b64('// unified site bundle'),
  'docs/overview/index.html': b64('<!doctype html>docs'),
  'studio-routes.json': b64('{"routes":["home"]}'),
};
const TMP_ROOT = join(tmpdir(), `pyric-serve-${VERSION}-${ASSET_VERSION}`);

let sdkCalls = 0;
let siteCalls = 0;

beforeAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  const embedded: EmbeddedAssets = {
    version: VERSION,
    assetVersion: ASSET_VERSION,
    workerVersion: WORKER_V,
    sdk: async () => {
      sdkCalls++;
      return { ...SDK_BLOB };
    },
    site: async () => {
      siteCalls++;
      return { ...SITE_BLOB };
    },
  };
  globalThis.__PYRIC_EMBEDDED__ = embedded;
});

afterAll(() => {
  globalThis.__PYRIC_EMBEDDED__ = undefined;
  rmSync(TMP_ROOT, { recursive: true, force: true });
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

describe('materializeServeAssets', () => {
  it('derives a stable identity from every embedded asset tree', () => {
    const first = embeddedAssetVersion({ sdk: { 'app.js': 'first' }, site: {} });
    const reordered = embeddedAssetVersion({ site: {}, sdk: { 'app.js': 'first' } });
    const changed = embeddedAssetVersion({ sdk: { 'app.js': 'second' }, site: {} });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });

  it('decodes the embedded SDK files to a real dir the namespace can serve', async () => {
    const { outDir, cached } = await materializeServeAssets();
    expect(outDir).toBe(join(TMP_ROOT, 'sdk'));
    expect(cached).toBe(false); // first materialize, clean tmp
    for (const [name, blob] of Object.entries(SDK_BLOB)) {
      const onDisk = readFileSync(join(outDir, name));
      expect(onDisk.equals(Buffer.from(blob, 'base64'))).toBe(true);
    }
    // The .complete marker gates the idempotent re-use.
    expect(existsSync(join(outDir, '.complete'))).toBe(true);
  });

  it('is idempotent — a second call reuses without re-decoding', async () => {
    const before = sdkCalls;
    const { outDir, cached } = await materializeServeAssets();
    expect(outDir).toBe(join(TMP_ROOT, 'sdk'));
    expect(cached).toBe(true);
    expect(sdkCalls).toBe(before); // loader not invoked again
  });

  it('isolates same-version standalone rebuilds by embedded asset content', () => {
    const version = `same-version-${process.pid}-${Date.now()}`;
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
        env: process.env,
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
    expect(second.outDir).not.toBe(first.outDir);
    expect(second.source).toBe('second build');

    rmSync(join(tmpdir(), `pyric-serve-${version}-content-a`), { recursive: true, force: true });
    rmSync(join(tmpdir(), `pyric-serve-${version}-content-b`), { recursive: true, force: true });
    rmSync(join(tmpdir(), `pyric-serve-${version}`), { recursive: true, force: true });
  });
});

describe('materializeSiteUi', () => {
  it('rebuilds the unified site tree, preserving nested relpaths', async () => {
    const dir = await materializeSiteUi();
    expect(dir).toBe(join(TMP_ROOT, 'site-ui'));
    for (const [rel, blob] of Object.entries(SITE_BLOB)) {
      const onDisk = readFileSync(join(dir, rel));
      expect(onDisk.equals(Buffer.from(blob, 'base64'))).toBe(true);
    }
    // Nested asset landed under its subdir, not flattened.
    expect(existsSync(join(dir, '_astro', 'app.js'))).toBe(true);
    expect(existsSync(join(dir, 'docs', 'overview', 'index.html'))).toBe(true);
  });

  it('is idempotent across calls', async () => {
    const before = siteCalls;
    await materializeSiteUi();
    expect(siteCalls).toBe(before);
  });
});

describe('embedded() guard', () => {
  it('throws a clear error when assets are requested without the global', async () => {
    const saved = globalThis.__PYRIC_EMBEDDED__;
    globalThis.__PYRIC_EMBEDDED__ = undefined;
    expect(() => embeddedWorkerVersion()).toThrow(/not a standalone build/);
    globalThis.__PYRIC_EMBEDDED__ = saved;
  });
});
