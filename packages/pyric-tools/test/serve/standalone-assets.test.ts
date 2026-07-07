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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  embeddedWorkerVersion,
  isStandalone,
  materializePlaygroundUi,
  materializeServeAssets,
  materializeStudioUi,
  type EmbeddedAssets,
} from '../../src/serve/standalone-assets.js';

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

const VERSION = 'unit-test-0';
const WORKER_V = 'wv-deadbeef';
const SDK_BLOB: Record<string, string> = { 'app.js': b64('// pyric app shim'), 'worker.js': b64('// worker') };
const STUDIO_BLOB: Record<string, string> = {
  'index.html': b64('<!doctype html>studio'),
  'assets/app.js': b64('// studio bundle'),
};
const PLAYGROUND_BLOB: Record<string, string> = {
  'index.html': b64('<!doctype html>playground'),
  '_astro/app.js': b64('// playground bundle'),
};
const TMP_ROOT = join(tmpdir(), `pyric-serve-${VERSION}`);

let sdkCalls = 0;
let studioCalls = 0;
let playgroundCalls = 0;

beforeAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
  const embedded: EmbeddedAssets = {
    version: VERSION,
    workerVersion: WORKER_V,
    sdk: async () => {
      sdkCalls++;
      return { ...SDK_BLOB };
    },
    studio: async () => {
      studioCalls++;
      return { ...STUDIO_BLOB };
    },
    playground: async () => {
      playgroundCalls++;
      return { ...PLAYGROUND_BLOB };
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
});

describe('materializeStudioUi', () => {
  it('rebuilds the studio tree, preserving nested relpaths', async () => {
    const dir = await materializeStudioUi();
    expect(dir).toBe(join(TMP_ROOT, 'studio-ui'));
    for (const [rel, blob] of Object.entries(STUDIO_BLOB)) {
      const onDisk = readFileSync(join(dir, rel));
      expect(onDisk.equals(Buffer.from(blob, 'base64'))).toBe(true);
    }
    // Nested asset landed under its subdir, not flattened.
    expect(existsSync(join(dir, 'assets', 'app.js'))).toBe(true);
  });

  it('is idempotent across calls', async () => {
    const before = studioCalls;
    await materializeStudioUi();
    expect(studioCalls).toBe(before);
  });
});

describe('materializePlaygroundUi', () => {
  it('rebuilds the playground tree, preserving nested relpaths', async () => {
    const dir = await materializePlaygroundUi();
    expect(dir).toBe(join(TMP_ROOT, 'playground-ui'));
    for (const [rel, blob] of Object.entries(PLAYGROUND_BLOB)) {
      const onDisk = readFileSync(join(dir!, rel));
      expect(onDisk.equals(Buffer.from(blob, 'base64'))).toBe(true);
    }
    expect(existsSync(join(dir!, '_astro', 'app.js'))).toBe(true);
  });

  it('is idempotent across calls', async () => {
    const before = playgroundCalls;
    await materializePlaygroundUi();
    expect(playgroundCalls).toBe(before);
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
