import { describe, expect, it } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startServe } from '../../src/cli/serve.js';
import type { EmbeddedAssets } from '../../src/serve/standalone-assets.js';
import { isAllowlistedStandaloneServeRoot } from '../../src/serve/standalone-cache-evict.js';
import { useTempDirs } from '../use-temp-dirs.js';

const testTimeoutMs = 30_000;
const makeTempDir = useTempDirs('pyric-serve-prod-no-firebase-');
const STANDALONE_UT_MARKER = '.pyric-standalone-serve-ut';

function projectWithoutFirebase(): string {
  const cwd = makeTempDir();
  writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: '.' } }));
  return cwd;
}

function projectWithFakeFirebase(): string {
  const cwd = makeTempDir();
  const publicDir = join(cwd, 'public');
  mkdirSync(publicDir, { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><html><body>ok</body></html>');
  writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: 'public' } }));
  const fbDir = join(cwd, 'node_modules', 'firebase');
  mkdirSync(fbDir, { recursive: true });
  writeFileSync(join(fbDir, 'package.json'), JSON.stringify({ name: 'firebase', version: '12.19.0' }));
  return cwd;
}

async function withProductionMode<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.PYRIC_AI_MODE;
  process.env.PYRIC_AI_MODE = 'production';
  try {
    return await run();
  } finally {
    if (saved === undefined) delete process.env.PYRIC_AI_MODE;
    else process.env.PYRIC_AI_MODE = saved;
  }
}

async function withStandaloneAssets<T>(run: () => Promise<T>): Promise<T> {
  const parent = join(homedir(), '.cache');
  mkdirSync(parent, { recursive: true });
  const cacheDir = mkdtempSync(join(parent, 'pyric-ut-serve-standalone-'));
  writeFileSync(join(cacheDir, STANDALONE_UT_MARKER), '1\n');
  const savedEmbedded = globalThis.__PYRIC_EMBEDDED__;
  const savedCacheEnv = process.env.PYRIC_STANDALONE_SERVE_CACHE_DIR;
  const encode = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const embedded: EmbeddedAssets = {
    version: '0.0.0-standalone-ut',
    assetVersion: 'ut1531',
    workerVersion: 'worker1531',
    sdk: async () => ({
      'app.js': encode('// sandbox app shim'),
      'app-ai-passthrough.js': encode('import "/__pyric/sdk/firebase-sdk-app.js";'),
      'app-ai-passthrough-app-check.js': encode('import "/__pyric/sdk/firebase-sdk-app-check.js";'),
      'init.js': encode('// init'),
      'worker.js': encode('// worker'),
    }),
    site: async () => ({}),
  };
  globalThis.__PYRIC_EMBEDDED__ = embedded;
  process.env.PYRIC_STANDALONE_SERVE_CACHE_DIR = cacheDir;
  try {
    return await run();
  } finally {
    globalThis.__PYRIC_EMBEDDED__ = savedEmbedded;
    if (savedCacheEnv === undefined) {
      delete process.env.PYRIC_STANDALONE_SERVE_CACHE_DIR;
    } else {
      process.env.PYRIC_STANDALONE_SERVE_CACHE_DIR = savedCacheEnv;
    }
    if (isAllowlistedStandaloneServeRoot(cacheDir)) {
      const stat = lstatSync(cacheDir, { throwIfNoEntry: false });
      if (
        stat !== undefined &&
        !stat.isSymbolicLink() &&
        stat.isDirectory() &&
        existsSync(join(cacheDir, STANDALONE_UT_MARKER))
      ) {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    }
  }
}

describe('startServe in production AI mode without a resolvable firebase', () => {
  it('stops at startup for plain pyric sandbox', async () => {
    const cwd = projectWithoutFirebase();
    const quiet = { note() {}, info() {} };
    await withProductionMode(async () => {
      await expect(startServe({ cwd, port: 0, watch: false, logger: quiet })).rejects.toThrow(
        /npm install firebase/,
      );
    });
  }, testTimeoutMs);

  it('starts with a child command, warns once, and answers the SDK URL with a clear 404', async () => {
    const cwd = projectWithoutFirebase();
    const lines: string[] = [];
    const record = (msg: string) => {
      lines.push(msg);
    };
    await withProductionMode(async () => {
      const runtime = await startServe({
        cwd,
        port: 0,
        watch: false,
        hasChildCommand: true,
        logger: { note: record, info: record },
      });
      try {
        const sdk = await fetch(new URL('/__pyric/sdk/firebase-sdk-app.js', runtime.handle.url));
        expect(sdk.status).toBe(404);
        expect(await sdk.text()).toContain('Firebase SDK was not built');
      } finally {
        await runtime.handle.stop();
      }
    });
    expect(lines.filter((line) => line.includes('no firebase package resolves'))).toHaveLength(1);
  }, testTimeoutMs);
});

describe('startServe on a standalone binary (#1531)', () => {
  it('refuses production AI mode at startup even when firebase is installed, naming @pyric/cli', async () => {
    const cwd = projectWithFakeFirebase();
    const quiet = { note() {}, info() {} };
    await withStandaloneAssets(async () => {
      await withProductionMode(async () => {
        await expect(startServe({ cwd, port: 0, watch: false, logger: quiet })).rejects.toThrow(
          /standalone pyric binary.*@pyric\/cli/,
        );
        await expect(
          startServe({ cwd, port: 0, watch: false, hasChildCommand: true, logger: quiet }),
        ).rejects.toThrow(/standalone pyric binary.*@pyric\/cli/);
      });
    });
  }, testTimeoutMs);

  it('serves embedded sandbox shims when AI mode is sandbox', async () => {
    const cwd = projectWithFakeFirebase();
    const quiet = { note() {}, info() {} };
    await withStandaloneAssets(async () => {
      const runtime = await startServe({ cwd, port: 0, watch: false, logger: quiet });
      try {
        const appRes = await fetch(new URL('/__pyric/sdk/app.js', runtime.handle.url));
        expect(appRes.status).toBe(200);
        expect(await appRes.text()).toContain('sandbox app shim');
      } finally {
        await runtime.handle.stop();
      }
    });
  }, testTimeoutMs);
});

describe('startServe inlined-SDK scanner limit warning (#1629)', () => {
  it('notes a warning when hosting.public exceeds the directory depth limit', async () => {
    const cwd = makeTempDir();
    const dist = join(cwd, 'dist');
    let deep = dist;
    for (let i = 1; i <= 18; i += 1) {
      deep = join(deep, `d${i}`);
    }
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'chunk.js'), 'export const clean = true;');
    writeFileSync(join(cwd, 'firebase.json'), JSON.stringify({ hosting: { public: 'dist' } }));

    const notes: string[] = [];
    await withStandaloneAssets(async () => {
      const runtime = await startServe({
        cwd,
        port: 0,
        watch: false,
        logger: { info() {}, note: (line) => notes.push(line) },
      });
      await runtime.handle.stop();
    });
    expect(
      notes.some((line) => line.includes('inlined-SDK scan of dist stopped early at its directory depth limit')),
    ).toBe(true);
  }, testTimeoutMs);
});
