/** `pyric dev` SDK bundler (plan step 1.1) — the stub-list generator, cache
 *  key, and a real esbuild smoke against the workspace pyric dist. */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bundleSdk,
  bundleWorker,
  cacheKey,
  collectFirebaseBindings,
  pyricPackageRoot,
  pyricVersion,
  resolveDocsUiDir,
  stubModuleSource,
  workerEntryPath,
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

describe('firebase stub generation (drift-proof list)', () => {
  it('collects named import AND re-export bindings from the real dist', () => {
    const bindings = collectFirebaseBindings(join(pyricPackageRoot(), 'dist'));
    // `export { Bytes, GeoPoint, documentId, FieldPath } from 'firebase/firestore'`
    const fs = bindings.get('firebase/firestore');
    expect(fs).toBeDefined();
    for (const n of ['Bytes', 'GeoPoint', 'documentId', 'FieldPath']) {
      expect(fs!.has(n)).toBe(true);
    }
    // App, Auth, and Storage are sandbox-only mirrors: package resolution chooses
    // Firebase or Pyric before either module loads.
    expect(bindings.has('firebase/app')).toBe(false);
    expect(bindings.has('firebase/auth')).toBe(false);
    // `import { get, set, … } from 'firebase/database'`
    expect(bindings.get('firebase/database')?.has('ref')).toBe(true);
    // Storage is a sandbox-only mirror: package resolution chooses
    // Firebase or Pyric before the module loads, so its built implementation
    // has no production bindings for the stub generator to collect.
    expect(bindings.has('firebase/storage')).toBe(false);
    // NAMESPACE-accessed members (`import * as fb`; `fb.where(...)`): pyric
    // builds the prod filter eagerly even on the sandbox path, so these MUST be
    // collected or `fb.where` is undefined at runtime ("(void 0) is not a
    // function"). Regression guard for the gate bug.
    const fs2 = collectFirebaseBindings(join(pyricPackageRoot(), 'dist')).get('firebase/firestore');
    for (const n of ['where', 'query', 'or', 'and', 'orderBy', 'doc', 'collection']) {
      expect(fs2!.has(n)).toBe(true);
    }
  });

  it('stub module is INERT — exports every name as a non-throwing deny proxy', () => {
    const src = stubModuleSource('firebase/firestore', new Set(['Bytes', 'where']));
    expect(src).toContain('export default deny');
    expect(src).toContain('export const Bytes = deny;');
    expect(src).toContain('export const where = deny;');
    // Inert, NOT throwing: pyric calls fb.where(...) / new fb.Bytes() eagerly on
    // the sandbox path; a throwing stub would break those constructors.
    expect(src).not.toContain('throw');
    expect(src).toContain('apply() { return deny; }');
    // Eval the stub and prove the proxy is callable + chainable without throwing.
    const mod = (0, eval)(
      '(function(){' + src.replace(/export default deny;?/, '').replace(/export const \w+ = deny;/g, '') + 'return deny;})()',
    );
    expect(() => mod('uid', '==', 'x')).not.toThrow();
    expect(mod.anything.deep).toBe(mod); // get → deny
  });

  it('firebase/app needs no special runtime class after app isolation', () => {
    const src = stubModuleSource('firebase/app', new Set(['FirebaseError', 'initializeApp']));
    expect(src).not.toContain('export class FirebaseError extends Error');
    expect(src).toContain('export const FirebaseError = deny;');
    expect(src).toContain('export const initializeApp = deny;');
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
});

describe('bundleSdk smoke (real esbuild, real pyric dist)', () => {
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
  it('defaultSdkEntries locates ai + app + auth + firestore + database + storage entries', () => {
    const entries = (require('../../src/serve/bundler.js') as typeof import('../../src/serve/bundler.js')).defaultSdkEntries();
    expect(Object.keys(entries).sort()).toEqual(['ai', 'app', 'auth', 'database', 'firestore', 'init', 'storage']);
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
});
