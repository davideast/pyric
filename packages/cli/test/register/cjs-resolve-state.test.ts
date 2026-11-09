/**
 * Unit tests for `cjs-resolve-state.ts`: verifies `Module._cache` importer-URL
 * forgery checks, `require.resolve(..., { paths })` vs `Module._load`
 * separation, nested `paths` getters, and `DirectResolveGuard` enforcement.
 * Runs on every Node major (including Node 22).
 */
import { describe, expect, it } from 'bun:test';
import { pathToFileURL } from 'node:url';
import { installCjsResolveState, type CjsLoaderApi } from '../../src/register/cjs-resolve-state.js';

function createFakeLoader(onHookResolve: (specifier: string, importerUrl: string) => string) {
  const cache: Record<string, unknown> = {};
  const loader: CjsLoaderApi = {
    _cache: cache,
    _resolveFilename(request, _parent, _isMain, options) {
      const opts = options as { paths?: unknown } | undefined;
      if (opts !== undefined && opts.paths !== undefined && !Array.isArray(opts.paths)) {
        throw new TypeError('options.paths must be an array');
      }
      return `/work/node_modules/${request}/index.js`;
    },
    _load(request, parent) {
      const importerFile = (parent as { filename?: string } | null)?.filename ?? '/work/entry.js';
      const url = onHookResolve(request, pathToFileURL(importerFile).href);
      return { loadedUrl: url };
    },
  };

  function runRequireResolve(caller: { filename: string }, specifier: string, options?: unknown): string {
    return onHookResolveWithOptions(specifier, caller, options);
  }

  function onHookResolveWithOptions(specifier: string, caller: { filename: string }, options?: unknown): string {
    return stateHookResolve(specifier, pathToFileURL(caller.filename).href, () => {
      const resolvedOptions =
        typeof options === 'object' && options !== null
          ? { paths: (options as { paths?: unknown }).paths }
          : undefined;
      return loader._resolveFilename(specifier, caller, false, resolvedOptions);
    });
  }

  let stateHookResolve: (specifier: string, importerUrl: string, nextResolve: () => string) => string = (
    _specifier,
    _importerUrl,
    nextResolve,
  ) => nextResolve();

  return {
    loader,
    cache,
    setHookResolve(fn: (specifier: string, importerUrl: string, nextResolve: () => string) => string) {
      stateHookResolve = fn;
    },
    requireFrom(caller: { filename: string }, specifier: string) {
      return loader._load(specifier, caller, false);
    },
    resolveFrom: runRequireResolve,
  };
}

describe('installCjsResolveState', () => {
  it('accepts cached Module._cache modules and rejects uncached createRequire modules with the same filename', () => {
    const adminFile = '/work/node_modules/firebase-admin/lib/firestore/index.js';
    const cachedAdmin = { filename: adminFile };
    const forgedAdmin = { filename: adminFile };
    const observations: Array<{ fromLoad: boolean; cached: boolean }> = [];

    const harness = createFakeLoader((specifier, importerUrl) =>
      harnessResolve(specifier, importerUrl, () =>
        harness.loader._resolveFilename(specifier, currentCaller, false, undefined),
      ),
    );
    let currentCaller: unknown = cachedAdmin;
    harness.cache[adminFile] = cachedAdmin;
    const state = installCjsResolveState({ loader: harness.loader });

    const harnessResolve = (_specifier: string, importerUrl: string, nextResolve: () => string) => {
      const turn = state.enterHookResolve();
      try {
        const resolved = nextResolve();
        observations.push({
          fromLoad: turn.fromLoad,
          cached: turn.hasCachedModuleImporter(importerUrl),
        });
        return resolved;
      } finally {
        turn.exit();
      }
    };
    harness.setHookResolve(harnessResolve);

    currentCaller = cachedAdmin;
    harness.requireFrom(cachedAdmin, '@google-cloud/firestore');

    currentCaller = forgedAdmin;
    harness.requireFrom(forgedAdmin, '@google-cloud/firestore');

    expect(observations).toEqual([
      { fromLoad: true, cached: true },
      { fromLoad: true, cached: false },
    ]);
    state.restore();
  });

  it('distinguishes require.resolve(id, { paths }) from Module._load, including nested paths-getter require() attacks', () => {
    const ritmFile = '/work/node_modules/require-in-the-middle/index.js';
    const cachedRitm = { filename: ritmFile };
    const forgedRitm = { filename: ritmFile };
    const results: Array<{ tag: string; fromLoad: boolean; probeOk: boolean }> = [];

    let activeLoadCaller: unknown = cachedRitm;
    const harness = createFakeLoader((specifier, importerUrl) =>
      hookResolve(specifier, importerUrl, () =>
        harness.loader._resolveFilename(specifier, activeLoadCaller, false, undefined),
      ),
    );
    harness.cache[ritmFile] = cachedRitm;
    const state = installCjsResolveState({ loader: harness.loader });

    let currentTag = '';
    const hookResolve = (_specifier: string, importerUrl: string, nextResolve: () => string) => {
      const tag = currentTag;
      const turn = state.enterHookResolve();
      try {
        const resolved = nextResolve();
        results.push({
          tag,
          fromLoad: turn.fromLoad,
          probeOk: turn.isResolveOnlyWithPaths(importerUrl),
        });
        return resolved;
      } finally {
        turn.exit();
      }
    };
    harness.setHookResolve(hookResolve);

    currentTag = 'cached-resolve-with-paths';
    harness.resolveFrom(cachedRitm, '@google-cloud/firestore', { paths: ['/work/node_modules'] });

    currentTag = 'cached-resolve-without-paths';
    harness.resolveFrom(cachedRitm, '@google-cloud/firestore');

    currentTag = 'cached-load';
    activeLoadCaller = cachedRitm;
    harness.requireFrom(cachedRitm, '@google-cloud/firestore');

    currentTag = 'forged-resolve-with-paths';
    harness.resolveFrom(forgedRitm, '@google-cloud/firestore', { paths: ['/work/node_modules'] });

    currentTag = 'outer-getter-resolve';
    harness.resolveFrom(forgedRitm, '@google-cloud/firestore', {
      get paths() {
        currentTag = 'inner-getter-load';
        activeLoadCaller = forgedRitm;
        harness.requireFrom(forgedRitm, '@google-cloud/firestore');
        return ['/work/node_modules'];
      },
    });

    expect(results).toEqual([
      { tag: 'cached-resolve-with-paths', fromLoad: false, probeOk: true },
      { tag: 'cached-resolve-without-paths', fromLoad: false, probeOk: false },
      { tag: 'cached-load', fromLoad: true, probeOk: false },
      { tag: 'forged-resolve-with-paths', fromLoad: false, probeOk: false },
      { tag: 'inner-getter-load', fromLoad: true, probeOk: false },
      { tag: 'outer-getter-resolve', fromLoad: false, probeOk: false },
    ]);
    state.restore();
  });

  it('defeats relativeResolveCache hits on uncached createRequire parent.path and clears awaitingHookResolve on Module.prototype.load', () => {
    const adminDir = '/work/node_modules/firebase-admin/lib/firestore';
    const adminFile = `${adminDir}/index.js`;
    const ritmFile = '/work/node_modules/require-in-the-middle/index.js';
    const cachedAdmin = { filename: adminFile, path: adminDir };
    const forgedAdmin = { filename: adminFile, path: adminDir };
    const cachedRitm = { filename: ritmFile, path: '/work/node_modules/require-in-the-middle' };
    const relativeResolveCache: Record<string, string> = {};
    const events: Array<{ fromLoad: boolean; cached: boolean; probeOk: boolean; restoredPath: string }> = [];

    let executeBody: (() => void) | null = null;
    const loader: CjsLoaderApi = {
      _cache: { [adminFile]: cachedAdmin, [ritmFile]: cachedRitm },
      prototype: {
        load() {
          executeBody?.();
        },
      },
      _resolveFilename(request) {
        return `/work/node_modules/${request}/index.js`;
      },
      _load(request, parent) {
        if (parent === undefined) {
          loader.prototype!.load.call(cachedAdmin, adminFile);
          return {};
        }
        const p = parent as { filename: string; path: string };
        const relKey = `${p.path}\x00${request}`;
        if (relativeResolveCache[relKey] !== undefined) {
          return { cachedHit: relativeResolveCache[relKey] };
        }
        const turn = state.enterHookResolve();
        try {
          const resolved = loader._resolveFilename(request, p, false, undefined);
          events.push({
            fromLoad: turn.fromLoad,
            cached: turn.hasCachedModuleImporter(pathToFileURL(p.filename).href),
            probeOk: turn.isResolveOnlyWithPaths(pathToFileURL(p.filename).href),
            restoredPath: p.path,
          });
          relativeResolveCache[relKey] = resolved;
          return { resolved };
        } finally {
          turn.exit();
        }
      },
    };

    const state = installCjsResolveState({ loader });

    loader._load('@google-cloud/firestore', cachedAdmin, false);
    loader._load('@google-cloud/firestore', forgedAdmin, false);
    expect(forgedAdmin.path).toBe(adminDir);

    executeBody = () => {
      const turn = state.enterHookResolve();
      try {
        loader._resolveFilename('@firebase/database-compat', cachedRitm, false, { paths: ['/work/node_modules'] });
        events.push({
          fromLoad: turn.fromLoad,
          cached: turn.hasCachedModuleImporter(pathToFileURL(ritmFile).href),
          probeOk: turn.isResolveOnlyWithPaths(pathToFileURL(ritmFile).href),
          restoredPath: cachedRitm.path,
        });
      } finally {
        turn.exit();
      }
    };
    loader._load(adminFile, undefined, false);

    expect(events).toEqual([
      { fromLoad: true, cached: true, probeOk: false, restoredPath: adminDir },
      { fromLoad: true, cached: false, probeOk: false, restoredPath: adminDir },
      { fromLoad: false, cached: true, probeOk: true, restoredPath: cachedRitm.path },
    ]);
    state.restore();
  });

  it('invokes directResolveGuard outside hook bridge turns, including pre-hook options.paths getters under requiresHookConditions', () => {
    const adminFile = '/work/node_modules/firebase-admin/lib/firestore/index.js';
    const cachedAdmin = { filename: adminFile, path: '/work/node_modules/firebase-admin/lib/firestore' };
    const forgedAdmin = { filename: adminFile, path: '/work/node_modules/firebase-admin/lib/firestore' };
    const loader: CjsLoaderApi = {
      _cache: { [adminFile]: cachedAdmin },
      _resolveFilename(request) {
        return `/work/node_modules/${request}/index.js`;
      },
      _load() {
        return {};
      },
    };
    const state = installCjsResolveState({
      loader,
      requiresHookConditions: true,
      directResolveGuard({ request, importerUrl, hasCachedModuleParent }) {
        if (!importerUrl || !hasCachedModuleParent(importerUrl)) {
          throw Object.assign(new Error(`stopped ${request}`), { code: 'PYRIC_REAL_SDK_STOPPED' });
        }
      },
    });

    expect(loader._resolveFilename('@google-cloud/firestore', cachedAdmin, false)).toBe(
      '/work/node_modules/@google-cloud/firestore/index.js',
    );
    expect(() => loader._resolveFilename('@google-cloud/firestore', forgedAdmin, false)).toThrow(
      'stopped @google-cloud/firestore',
    );

    // Mirrors Node 24's `resolveForCJSWithHooks`: `options.paths` getter runs
    // after `enterHookResolve()` but BEFORE Node calls `Module._resolveFilename`
    // with `{ paths, conditions }`. A 2-arg `Module._resolveFilename(id, parent)`
    // inside the getter lacks `'conditions' in options`, so `directResolveGuard` runs.
    const turn = state.enterHookResolve();
    let getterError: unknown = null;
    try {
      const userOptions = {
        get paths() {
          try {
            loader._resolveFilename('@google-cloud/firestore', forgedAdmin, false);
          } catch (error) {
            getterError = error;
          }
          return ['/work/node_modules'];
        },
      };
      loader._resolveFilename('@google-cloud/firestore', forgedAdmin, false, {
        paths: userOptions.paths,
        conditions: new Set(['require', 'node']),
      });
      expect(turn.hasCachedModuleImporter(pathToFileURL(adminFile).href)).toBe(false);
    } finally {
      turn.exit();
    }
    expect((getterError as { code?: string } | null)?.code).toBe('PYRIC_REAL_SDK_STOPPED');
    state.restore();
  });
});
