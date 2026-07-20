/** `pyric dev` SDK bundler (plan step 1.1) — the stub-list generator, cache
 *  key, and a real esbuild smoke against the workspace pyric dist. */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleSdk,
  bundleWorker,
  cacheKey,
  pyricPackageRoot,
  pyricVersion,
  resolveDocsUiDir,
  sourceTreeHash,
  workerEntryPath,
  workerBundleEpoch,
  workerSourceHash,
} from '../../src/serve/bundler.js';

describe('pyric dist discovery', () => {
  it('locates the pyric package root + version', () => {
    const root = pyricPackageRoot();
    expect(root.endsWith('/pyric') || root.includes('/pyric')).toBe(true);
    expect(pyricVersion(root)).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('resolveDocsUiDir (embed fallback)', () => {
  it('returns null when the built docs-ui dir is absent (drives the CLI soft-warn)', () => {
    // Running from src/serve, there is no sibling `docs-ui/` (that only exists
    // in the built dist after scripts/build.sh Phase 5), so the resolver must
    // return null rather than throw — the `--ui` path then soft-warns and
    // leaves /__pyric/ui/docs/ un-mounted instead of crashing.
    expect(resolveDocsUiDir()).toBeNull();
  });
});

describe('sandbox mirror isolation', () => {
  it('bundles the public database mirror without a firebase/database runtime', async () => {
    const manifest = JSON.parse(
      readFileSync(join(pyricPackageRoot(), 'package.json'), 'utf8'),
    ) as { exports: Record<string, unknown> };
    expect(manifest.exports['./database']).toEqual({
      types: './dist/database/index.d.ts',
      import: './dist/database/index.js',
    });
    expect(manifest.exports['./database/modular']).toBeUndefined();

    const dir = mkdtempSync(join(tmpdir(), 'pyric-database-isolation-'));
    const entry = join(dir, 'database.ts');
    writeFileSync(
      entry,
      `export * from 'pyric/database';`,
    );
    const result = await bundleSdk({
      entries: { database: entry },
      cacheRoot: join(dir, 'cache'),
      minify: false,
    });
    const source = readFileSync(
      result.files.find((file) => file.endsWith('/database.js'))!,
      'utf8',
    );
    expect(source).not.toMatch(/from\s*['"]firebase\//);
  });
});

describe('cache key', () => {
  function entryFixture(content: string): Record<string, string> {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-key-'));
    const file = join(dir, 'entry.ts');
    writeFileSync(file, content);
    return { auth: file };
  }

  it('is stable for identical inputs and changes when an entry changes', () => {
    const a = entryFixture('export const x = 1;');
    const k1 = cacheKey({ entries: a }, '1.2.3');
    const k2 = cacheKey({ entries: a }, '1.2.3');
    expect(k1).toBe(k2);
    expect(k1.startsWith('1.2.3-')).toBe(true);
    writeFileSync(a.auth!, 'export const x = 2;');
    expect(cacheKey({ entries: a }, '1.2.3')).not.toBe(k1);
    expect(cacheKey({ entries: a }, '9.9.9')).not.toBe(k1); // version-sensitive
  });

  it('changes when an imported worker client outside the entries directory changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-serve-key-graph-'));
    const entries = join(root, 'serve', 'entries');
    const workerClient = join(root, 'serve', 'worker', 'client');
    mkdirSync(entries, { recursive: true });
    mkdirSync(workerClient, { recursive: true });
    const appEntry = join(entries, 'app.ts');
    const authClient = join(workerClient, 'auth.ts');
    writeFileSync(appEntry, "export { authClient } from '../worker/client/auth.js';");
    writeFileSync(authClient, 'export const authClient = 1;');
    const options = { entries: { app: appEntry } };
    const first = cacheKey(options, '1.2.3', root);

    writeFileSync(authClient, 'export const authClient = 2;');

    expect(cacheKey(options, '1.2.3', root)).not.toBe(first);
  });

  it('changes when the installed pyric implementation changes without a version bump', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-serve-key-pyric-'));
    const cliRoot = join(root, 'cli');
    const pyricRoot = join(root, 'pyric');
    mkdirSync(cliRoot, { recursive: true });
    mkdirSync(join(pyricRoot, 'dist'), { recursive: true });
    writeFileSync(join(cliRoot, 'entry.ts'), 'export const entry = true;');
    writeFileSync(join(pyricRoot, 'dist', 'app.js'), 'export const generation = 1;');
    const options = { entries: { app: join(cliRoot, 'entry.ts') } };
    const first = cacheKey(options, '1.2.3', cliRoot, pyricRoot);

    writeFileSync(join(pyricRoot, 'dist', 'app.js'), 'export const generation = 2;');

    expect(cacheKey(options, '1.2.3', cliRoot, pyricRoot)).not.toBe(first);
  });

  it('changes when dependency resolution metadata changes without a CLI version bump', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-serve-key-dependencies-'));
    const cliRoot = join(root, 'cli');
    const pyricRoot = join(root, 'pyric');
    mkdirSync(cliRoot, { recursive: true });
    mkdirSync(join(pyricRoot, 'dist'), { recursive: true });
    const entry = join(cliRoot, 'entry.ts');
    writeFileSync(entry, 'export const entry = true;');
    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({
      name: '@pyric/cli',
      dependencies: { zod: '3.23.0' },
    }));
    writeFileSync(join(pyricRoot, 'package.json'), JSON.stringify({
      name: 'pyric',
      version: '1.2.3',
    }));
    writeFileSync(join(pyricRoot, 'dist', 'app.js'), 'export const app = true;');
    const options = { entries: { app: entry } };
    const first = cacheKey(options, '1.2.3', cliRoot, pyricRoot);

    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({
      name: '@pyric/cli',
      dependencies: { zod: '3.25.0' },
    }));

    expect(cacheKey(options, '1.2.3', cliRoot, pyricRoot)).not.toBe(first);
  });
});

describe('worker source hashing', () => {
  it('changes when a nested worker source changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-worker-source-hash-'));
    const nested = join(dir, 'client');
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, 'entry.ts'), 'export const entry = true;');
    writeFileSync(join(nested, 'auth.ts'), 'export const generation = 1;');
    const first = sourceTreeHash(dir);

    writeFileSync(join(nested, 'auth.ts'), 'export const generation = 2;');

    expect(sourceTreeHash(dir)).not.toBe(first);
  });

  it('changes when the installed pyric implementation changes without a version bump', () => {
    const pyricRoot = mkdtempSync(join(tmpdir(), 'pyric-worker-hash-pyric-'));
    mkdirSync(join(pyricRoot, 'dist'), { recursive: true });
    writeFileSync(join(pyricRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(pyricRoot, 'dist', 'app.js'), 'export const generation = 1;');
    const first = workerSourceHash(pyricRoot);

    writeFileSync(join(pyricRoot, 'dist', 'app.js'), 'export const generation = 2;');

    expect(workerSourceHash(pyricRoot)).not.toBe(first);
  });

  it('changes when an executable worker dependency outside serve/worker changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-worker-hash-cli-'));
    const cliRoot = join(root, 'cli');
    const pyricRoot = join(root, 'pyric');
    mkdirSync(join(cliRoot, 'bridge', 'client'), { recursive: true });
    mkdirSync(join(pyricRoot, 'dist'), { recursive: true });
    writeFileSync(join(pyricRoot, 'package.json'), JSON.stringify({ version: '1.2.3' }));
    writeFileSync(join(pyricRoot, 'dist', 'app.js'), 'export const app = true;');
    const dependency = join(cliRoot, 'bridge', 'client', 'dispatch.ts');
    writeFileSync(dependency, 'export const generation = 1;');
    const first = workerSourceHash(pyricRoot, cliRoot);

    writeFileSync(dependency, 'export const generation = 2;');

    expect(workerSourceHash(pyricRoot, cliRoot)).not.toBe(first);
  });

  it('changes when worker dependency resolution changes without a CLI version bump', () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-worker-hash-dependencies-'));
    const cliRoot = join(root, 'cli');
    const pyricRoot = join(root, 'pyric');
    mkdirSync(cliRoot, { recursive: true });
    mkdirSync(join(pyricRoot, 'dist'), { recursive: true });
    writeFileSync(join(cliRoot, 'worker.ts'), 'export const worker = true;');
    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({
      name: '@pyric/cli',
      dependencies: { zod: '3.23.0' },
    }));
    writeFileSync(join(pyricRoot, 'package.json'), JSON.stringify({
      name: 'pyric',
      version: '1.2.3',
    }));
    writeFileSync(join(pyricRoot, 'dist', 'app.js'), 'export const app = true;');
    const first = workerSourceHash(pyricRoot, cliRoot);

    writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({
      name: '@pyric/cli',
      dependencies: { zod: '3.25.0' },
    }));

    expect(workerSourceHash(pyricRoot, cliRoot)).not.toBe(first);
  });
});

describe('bundleSdk smoke (real esbuild, real pyric dist)', () => {
  it('keeps concurrent no-cache generations in distinct immutable directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-no-cache-'));
    const entry = join(dir, 'entry.ts');
    writeFileSync(entry, 'export const generation = true;');
    const options = {
      entries: { app: entry },
      cacheRoot: join(dir, 'cache'),
      noCache: true,
      minify: false,
    };

    const [first, second] = await Promise.all([
      bundleSdk(options),
      bundleSdk(options),
    ]);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(first.outDir).not.toBe(second.outDir);
    expect(readFileSync(join(first.outDir, 'app.js'), 'utf8')).toContain('generation');
    expect(readFileSync(join(second.outDir, 'app.js'), 'utf8')).toContain('generation');

    const firstGeneration = join(first.outDir, '..');
    const secondGeneration = join(second.outDir, '..');
    first.dispose();
    second.dispose();
    expect(existsSync(firstGeneration)).toBe(false);
    expect(existsSync(secondGeneration)).toBe(false);
  }, 30_000);

  it('removes a no-cache generation when bundling fails before a server starts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-no-cache-failure-'));
    const cacheRoot = join(dir, 'cache');
    const brokenEntry = join(dir, 'broken.ts');
    writeFileSync(brokenEntry, 'export const = ;');

    await expect(bundleSdk({
      entries: { app: brokenEntry },
      cacheRoot,
      noCache: true,
      minify: false,
    })).rejects.toThrow();

    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('.no-cache-'))).toEqual([]);
  }, 30_000);

  it('bundles a browser-standalone entry importing pyric/firestore; cache round-trips', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-bundle-'));
    const entry = join(dir, 'smoke.ts');
    writeFileSync(
      entry,
      `import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
export const db = getFirestore(initializeSandbox());`,
    );
    const cacheRoot = join(dir, 'cache');

    const first = await bundleSdk({ entries: { smoke: entry }, cacheRoot, minify: false });
    expect(first.cached).toBe(false);
    expect(first.files.some((f) => f.endsWith('smoke.js'))).toBe(true);
    const out = readFileSync(first.files.find((f) => f.endsWith('smoke.js'))!, 'utf8');
    // browser-standalone: no bare firebase/node imports survive
    expect(out).not.toMatch(/from\s*['"]firebase\//);
    expect(out).not.toMatch(/from\s*['"]node:/);

    const second = await bundleSdk({ entries: { smoke: entry }, cacheRoot });
    expect(second.cached).toBe(true);
    expect(second.outDir).toBe(first.outDir);
  }, 30_000);
});

describe('the real wrapper entries (plan step 1.2)', () => {
  it('defaultSdkEntries locates every served Firebase entry including both Messaging planes', () => {
    const entries = (require('../../src/serve/bundler.js') as typeof import('../../src/serve/bundler.js')).defaultSdkEntries();
    expect(Object.keys(entries).sort()).toEqual([
      'ai',
      'app',
      'auth',
      'database',
      'firestore',
      'init',
      'messaging',
      'messaging-sw',
      'storage',
    ]);
  });

  it('bundles browser-standalone with a SINGLE shared runtime chunk', async () => {
    const { bundleSdk, defaultSdkEntries } = await import('../../src/serve/bundler.js');
    const { mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-entries-'));
    const result = await bundleSdk({ entries: defaultSdkEntries(), cacheRoot: join(dir, 'cache'), minify: false });
    const names = result.files.map((f) => f.split('/').pop()!);
    expect(names).toContain('ai.js');
    expect(names).toContain('app.js');
    expect(names).toContain('auth.js');
    expect(names).toContain('database.js');
    expect(names).toContain('firestore.js');
    expect(names).toContain('messaging.js');
    expect(names).toContain('messaging-sw.js');
    expect(names).toContain('storage.js');
    expect(names).toContain('init.js');
    // splitting produced shared chunk(s); the runtime/sandbox must NOT be
    // duplicated into both entry bundles. Chunk names self-identify as the
    // sandbox shim (provenance, flow doc section 3a).
    const chunks = names.filter((n) => n.startsWith('pyric-sandbox-'));
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const authSrc = readFileSync(result.files.find((f) => f.endsWith('/auth.js'))!, 'utf8');
    const dbSrc = readFileSync(result.files.find((f) => f.endsWith('/database.js'))!, 'utf8');
    const fsSrc = readFileSync(result.files.find((f) => f.endsWith('/firestore.js'))!, 'utf8');
    const storageSrc = readFileSync(result.files.find((f) => f.endsWith('/storage.js'))!, 'utf8');
    expect(authSrc).toMatch(/from\s*["']\.\/pyric-sandbox-/);
    expect(dbSrc).toMatch(/from\s*["']\.\/pyric-sandbox-/);
    expect(fsSrc).toMatch(/from\s*["']\.\/pyric-sandbox-/);
    expect(storageSrc).toMatch(/from\s*["']\.\/pyric-sandbox-/);
    expect(authSrc).not.toMatch(/initializeSandbox/); // sandbox lives in the chunk
    expect(fsSrc).not.toMatch(/initializeSandbox/);
    for (const f of result.files) {
      const src = readFileSync(f, 'utf8');
      // provenance banner on every served bundle
      expect(src).toContain('NOT the real Firebase SDK');
      expect(src).not.toMatch(/from\s*["']firebase\//);
      expect(src).not.toMatch(/from\s*["']node:/);
    }
  }, 30_000);

  it('built bundles export the section 3c tier-2 surface (import-time failure class)', async () => {
    const { bundleSdk, defaultSdkEntries } = await import('../../src/serve/bundler.js');
    const { mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-tier2-'));
    const result = await bundleSdk({ entries: defaultSdkEntries(), cacheRoot: join(dir, 'cache'), minify: false });
    // The bundles are browser-platform (executing them under bun trips
    // js-md5's environment sniff), so assert the NAMED EXPORTS — the thing
    // a missing name would fail at import time — from the ESM export lists.
    const exportedNames = (file: string): Set<string> => {
      const src = readFileSync(file, 'utf8');
      const names = new Set<string>();
      for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const piece of m[1]!.split(',')) {
          const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
          if (name) names.add(name);
        }
      }
      return names;
    };
    const fsExports = exportedNames(result.files.find((f) => f.endsWith('/firestore.js'))!);
    for (const name of [
      'initializeFirestore', 'persistentLocalCache', 'memoryLocalCache',
      'persistentSingleTabManager', 'persistentMultipleTabManager',
      'enableIndexedDbPersistence', 'clearIndexedDbPersistence',
      'waitForPendingWrites', 'CACHE_SIZE_UNLIMITED',
    ]) {
      expect(fsExports.has(name)).toBe(true);
    }
    const authExports = exportedNames(result.files.find((f) => f.endsWith('/auth.js'))!);
    for (const name of ['setPersistence', 'browserLocalPersistence', 'browserSessionPersistence', 'inMemoryPersistence']) {
      expect(authExports.has(name)).toBe(true);
    }
  }, 30_000);

  it('dual-path entries (3c.E) export the COMPLETE firebase surface', async () => {
    // The worker-path bindings are `export const x = useWorker ? … : …`, so the
    // export NAMES (what fails the page at import time) are identical on both
    // paths by construction. Lock the full set so a dropped export regresses
    // loudly. Runtime branch behavior is the browser gate's job.
    const { bundleSdk, defaultSdkEntries } = await import('../../src/serve/bundler.js');
    const { mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-surface-'));
    const result = await bundleSdk({ entries: defaultSdkEntries(), cacheRoot: join(dir, 'cache'), minify: false });
    const exportedNames = (file: string): Set<string> => {
      const src = readFileSync(file, 'utf8');
      const names = new Set<string>();
      for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
        for (const piece of m[1]!.split(',')) {
          const name = piece.trim().split(/\s+as\s+/).pop()?.trim();
          if (name) names.add(name);
        }
      }
      return names;
    };

    const fs = exportedNames(result.files.find((f) => f.endsWith('/firestore.js'))!);
    for (const name of [
      'onSnapshot', 'collection', 'collectionGroup', 'doc', 'getDoc', 'getDocs',
      'setDoc', 'addDoc', 'updateDoc', 'deleteDoc', 'query', 'where', 'or', 'and',
      'orderBy', 'limit', 'limitToLast', 'startAt', 'startAfter', 'endAt', 'endBefore',
      'runTransaction', 'writeBatch', 'serverTimestamp', 'increment', 'arrayUnion',
      'arrayRemove', 'deleteField', 'Timestamp', 'getFirestore',
    ]) {
      expect(fs.has(name)).toBe(true);
    }

    const auth = exportedNames(result.files.find((f) => f.endsWith('/auth.js'))!);
    for (const name of [
      'getAuth', 'connectAuthEmulator', 'onAuthStateChanged', 'onIdTokenChanged',
      'signInAnonymously', 'signInWithEmailAndPassword', 'createUserWithEmailAndPassword',
      'signOut', 'signInWithPopup', 'signInWithCredential', 'signInWithRedirect',
      'getRedirectResult', 'GoogleAuthProvider', 'EmailAuthProvider', 'FacebookAuthProvider',
      'GithubAuthProvider', 'OAuthProvider', 'setPersistence',
    ]) {
      expect(auth.has(name)).toBe(true);
    }

    const database = exportedNames(result.files.find((f) => f.endsWith('/database.js'))!);
    for (const name of [
      'getDatabase', 'ref', 'child', 'get', 'set', 'update', 'remove', 'push',
      'onValue', 'off', 'serverTimestamp', 'connectDatabaseEmulator',
      'runTransaction', 'query', 'orderByChild', 'orderByKey', 'orderByValue',
      'startAt', 'startAfter', 'endAt', 'endBefore', 'equalTo',
      'limitToFirst', 'limitToLast',
    ]) {
      expect(database.has(name)).toBe(true);
    }

    const storage = exportedNames(result.files.find((f) => f.endsWith('/storage.js'))!);
    for (const name of [
      'getStorage', 'ref', 'listAll', 'getMetadata', 'connectStorageEmulator',
      'uploadBytes', 'uploadString', 'getBytes', 'getBlob', 'getDownloadURL', 'deleteObject',
      'updateMetadata', 'StorageError',
    ]) {
      expect(storage.has(name)).toBe(true);
    }
  }, 30_000);
});

describe('bundleWorker — the SharedWorker script (Phase 3c.A)', () => {
  it('locates the worker entry sibling', () => {
    const p = workerEntryPath();
    expect(p.endsWith('/worker/entry.ts') || p.endsWith('/worker/entry.js')).toBe(true);
  });

  it('bundles the real worker entry as a classic-worker iife; marker caches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-worker-bundle-'));
    const file = await bundleWorker({ outDir: dir, noCache: true, minify: false });
    expect(file.endsWith('/worker.js')).toBe(true);
    const src = readFileSync(file, 'utf8');

    // Classic-worker shape: an iife wrapper, NOT an ESM module. esbuild emits
    // `"use strict"; (() => { … })()` for format:'iife'. A SharedWorker opened
    // with `{ type: 'classic' }` rejects top-level import/export. Assert the
    // wrapper signature + the absence of real ESM `import/export … from`
    // statements. (A naive `^export` line filter is fooled by firestore-rules
    // helper SOURCE embedded as strings — `export function isOwner…` — so we
    // require the `from` clause that only real module syntax carries.)
    expect(src.replace(/^\/\*[^]*?\*\/\s*/, '')).toMatch(/^"use strict";\s*\(\(\) => \{/);
    const esmStatements = src.match(/^\s*(import|export)\b[^\n]*\bfrom\s*["']/gm) ?? [];
    expect(esmStatements).toEqual([]);

    // Browser-standalone: no bare firebase/* or node: specifiers survive.
    expect(src).not.toMatch(/from\s*["']firebase\//);
    expect(src).not.toMatch(/from\s*["']node:/);
    // Provenance banner + the connect wiring that makes it a SharedWorker host.
    expect(src).toContain('NOT the real Firebase SDK');
    expect(src).toContain('onconnect');

    // Marker cache: a second call without noCache returns the same file fast.
    const again = await bundleWorker({ outDir: dir });
    expect(again).toBe(file);
  }, 30_000);

  it('derives the worker epoch from executable output, not unrelated files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pyric-worker-epoch-'));
    const entry = join(root, 'worker.ts');
    const unrelated = join(root, 'runtime-chip.ts');
    writeFileSync(entry, 'globalThis.workerEpoch = __PYRIC_WORKER_VERSION__;');
    writeFileSync(unrelated, 'export const chip = 1;');

    const firstDir = join(root, 'first');
    await bundleWorker({ outDir: firstDir, noCache: true, entryPath: entry });
    const first = workerBundleEpoch(firstDir);

    writeFileSync(unrelated, 'export const chip = 2;');
    const secondDir = join(root, 'second');
    await bundleWorker({ outDir: secondDir, noCache: true, entryPath: entry });

    expect(workerBundleEpoch(secondDir)).toBe(first);
    expect(readFileSync(join(firstDir, 'worker.js'), 'utf8')).toContain(first);
  }, 30_000);
});
