/**
 * Tracks active CommonJS `Module._load`, `Module.prototype.load`, and
 * `Module._resolveFilename` turns so `@pyric/live/register`'s synchronous
 * resolve hook can verify:
 *
 *   1. Whether a CJS resolution came from the `Module` instance currently
 *      stored at `Module._cache[parent.filename] === parent` — defeating
 *      importer-URL forgery via `createRequire(...)`, `vm` stack filenames,
 *      and Node's `relativeResolveCache` fast-path on `parent.path`. (This
 *      guards importer-URL forgery, not in-process code that directly mutates,
 *      reads, or borrows entries from `Module._cache` or loader internals.)
 *   2. Whether a CJS resolution is strictly `require.resolve(id, { paths })`
 *      rather than `Module._load` (`require()`), including nested `paths`
 *      getters and ESM-imported CJS modules whose outer `Module._load` skipped
 *      `registerHooks.resolve`.
 *   3. Whether a direct `Module._resolveFilename` lookup outside
 *      `registerHooks.resolve` (such as `require-in-the-middle`'s pre-load
 *      `ExportsCache` check) targets a stopped SDK from a non-Admin caller.
 */
import Module from 'node:module';
import { pathToFileURL } from 'node:url';
import { canonicalFileUrl } from './package-identity.js';

export interface CjsModulePrototype {
  load: (this: unknown, filename: string) => void;
}

export interface CjsLoaderApi {
  _load: (this: unknown, request: string, parent: unknown, isMain: boolean, ...rest: unknown[]) => unknown;
  _resolveFilename: (
    this: unknown,
    request: string,
    parent: unknown,
    isMain: boolean,
    options?: unknown,
    ...rest: unknown[]
  ) => string;
  _cache: Record<string, unknown>;
  prototype?: CjsModulePrototype;
}

interface LoadFrame {
  readonly parent: unknown;
  readonly restoreParentPath: (() => void) | null;
  awaitingHookResolve: boolean;
}

interface TurnRecord {
  readonly fromLoad: boolean;
  readonly loadParent: unknown;
  inResolveFilename: boolean;
  resolvedParent: unknown;
  hasExplicitPaths: boolean;
  exited: boolean;
}

export interface CjsResolveTurn {
  /** True when this hook resolution is loading a module via `Module._load`. */
  readonly fromLoad: boolean;
  /** True when the calling `Module` matches `importerUrl` and `Module._cache[filename] === caller`. */
  hasCachedModuleImporter(importerUrl: string): boolean;
  /** True only for `require.resolve(id, { paths: [...] })` from a `Module` in `Module._cache`. */
  isResolveOnlyWithPaths(importerUrl: string): boolean;
  /** Pop this resolution turn from the active stack. */
  exit(): void;
}

export interface CjsResolveState {
  enterHookResolve(): CjsResolveTurn;
  restore(): void;
}

export interface DirectResolveCheckInput {
  readonly request: string;
  readonly resolvedFilename: string;
  readonly importerUrl: string | undefined;
  hasCachedModuleParent(importerUrl: string): boolean;
}

export type DirectResolveGuard = (input: DirectResolveCheckInput) => void;

export interface CjsResolveStateOptions {
  readonly loader?: CjsLoaderApi;
  readonly directResolveGuard?: DirectResolveGuard;
  readonly requiresHookConditions?: boolean;
}

function normalizeResolveOptions(options: unknown): { options: unknown; hasExplicitPaths: boolean } {
  if (typeof options !== 'object' || options === null) {
    return { options, hasExplicitPaths: false };
  }
  const rawPaths = (options as { paths?: unknown }).paths;
  if (rawPaths === undefined) {
    return { options, hasExplicitPaths: false };
  }
  const hasExplicitPaths = Array.isArray(rawPaths);
  const nextOptions: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key === 'string' && key !== 'paths') {
      nextOptions[key] = (options as Record<string, unknown>)[key];
    }
  }
  if (hasExplicitPaths) {
    nextOptions.paths = [...rawPaths];
  } else {
    nextOptions.paths = rawPaths;
  }
  return { options: nextOptions, hasExplicitPaths };
}

/**
 * Temporarily prefixes `parent.path` on uncached `Module` parents (such as
 * `createRequire(adminFile)`) so Node's `Module._load` misses its internal
 * `relativeResolveCache` (`"${parent.path}\x00${request}"`), restoring
 * `parent.path` as soon as `registerHooks.resolve` or `Module.prototype.load` enters.
 */
function guardUncachedParentPath(
  cache: Record<string, unknown>,
  parent: unknown,
  nonce: number,
): (() => void) | null {
  if (typeof parent !== 'object' || parent === null) return null;
  const candidate = parent as { filename?: unknown; path?: unknown };
  if (typeof candidate.filename !== 'string' || cache[candidate.filename] === parent) return null;
  if (typeof candidate.path !== 'string') return null;
  const savedPath = candidate.path;
  let restored = false;
  candidate.path = `\x00uncached:${nonce}:${savedPath}`;
  return () => {
    if (restored) return;
    restored = true;
    candidate.path = savedPath;
  };
}

function moduleFileUrl(candidate: unknown): string | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const filename = (candidate as { filename?: unknown }).filename;
  if (typeof filename !== 'string' || filename === '') return undefined;
  return pathToFileURL(filename).href;
}

function isCachedModuleAtUrl(
  cache: Record<string, unknown>,
  candidate: unknown,
  importerUrl: string,
): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const filename = (candidate as { filename?: unknown }).filename;
  if (typeof filename !== 'string' || filename === '') return false;
  if (cache[filename] !== candidate) return false;
  return pathToFileURL(filename).href === canonicalFileUrl(importerUrl);
}

/**
 * Node's `resolveForCJSWithHooks` `defaultResolve` evaluates `options.paths`
 * before entering `Module._resolveFilename`, then passes `{ paths, conditions }`.
 * Requiring `'conditions' in options` ensures a direct `Module._resolveFilename(id, parent)`
 * call inside an `options.paths` getter cannot claim the outer hook turn.
 */
function isHookBridgeResolveCall(options: unknown, requiresHookConditions: boolean): boolean {
  if (!requiresHookConditions) return true;
  return typeof options === 'object' && options !== null && 'conditions' in options;
}

export function installCjsResolveState(options: CjsResolveStateOptions = {}): CjsResolveState {
  const defaultLoader = Module as unknown as CjsLoaderApi;
  const loader = options.loader ?? defaultLoader;
  const directResolveGuard = options.directResolveGuard;
  const requiresHookConditions = options.requiresHookConditions ?? (loader === defaultLoader);
  const originalLoad = loader._load;
  const originalResolveFilename = loader._resolveFilename;
  const originalPrototypeLoad = loader.prototype?.load;
  const loadStack: LoadFrame[] = [];
  const turnStack: TurnRecord[] = [];
  let uncachedNonce = 0;

  loader._load = function wrappedLoad(request, parent, isMain, ...rest) {
    const restoreParentPath = guardUncachedParentPath(loader._cache, parent, ++uncachedNonce);
    const frame: LoadFrame = { parent, restoreParentPath, awaitingHookResolve: true };
    loadStack.push(frame);
    try {
      return originalLoad.call(this, request, parent, isMain, ...rest);
    } finally {
      restoreParentPath?.();
      loadStack.pop();
    }
  };

  if (loader.prototype !== undefined && typeof originalPrototypeLoad === 'function') {
    loader.prototype.load = function wrappedPrototypeLoad(filename) {
      const topLoad = loadStack.at(-1);
      if (topLoad !== undefined) {
        topLoad.awaitingHookResolve = false;
        topLoad.restoreParentPath?.();
      }
      return originalPrototypeLoad.call(this, filename);
    };
  }

  loader._resolveFilename = function wrappedResolveFilename(request, parent, isMain, resolveOptions, ...rest) {
    const topTurn = turnStack.at(-1);
    let activeTurn: TurnRecord | undefined;
    const claimsActiveTurn =
      topTurn !== undefined &&
      !topTurn.inResolveFilename &&
      isHookBridgeResolveCall(resolveOptions, requiresHookConditions);
    if (claimsActiveTurn) {
      activeTurn = topTurn;
      activeTurn.inResolveFilename = true;
    }
    try {
      const normalized = normalizeResolveOptions(resolveOptions);
      if (activeTurn !== undefined) {
        activeTurn.resolvedParent = parent;
        activeTurn.hasExplicitPaths = normalized.hasExplicitPaths;
      }
      const resolved = originalResolveFilename.call(this, request, parent, isMain, normalized.options, ...rest);
      const isDirectOutsideLoad = activeTurn === undefined && !(loadStack.at(-1)?.awaitingHookResolve ?? false);
      if (isDirectOutsideLoad && directResolveGuard !== undefined) {
        directResolveGuard({
          request,
          resolvedFilename: resolved,
          importerUrl: moduleFileUrl(parent),
          hasCachedModuleParent: (importerUrl) => isCachedModuleAtUrl(loader._cache, parent, importerUrl),
        });
      }
      return resolved;
    } finally {
      if (activeTurn !== undefined) {
        activeTurn.inResolveFilename = false;
      }
    }
  };

  return {
    enterHookResolve(): CjsResolveTurn {
      const topLoad = loadStack.at(-1);
      const fromLoad = topLoad !== undefined && topLoad.awaitingHookResolve;
      if (fromLoad) {
        topLoad.awaitingHookResolve = false;
        topLoad.restoreParentPath?.();
      }
      const record: TurnRecord = {
        fromLoad,
        loadParent: fromLoad ? topLoad.parent : undefined,
        inResolveFilename: false,
        resolvedParent: undefined,
        hasExplicitPaths: false,
        exited: false,
      };
      turnStack.push(record);
      return {
        fromLoad,
        hasCachedModuleImporter(importerUrl: string): boolean {
          const caller = record.fromLoad ? record.loadParent : record.resolvedParent;
          return isCachedModuleAtUrl(loader._cache, caller, importerUrl);
        },
        isResolveOnlyWithPaths(importerUrl: string): boolean {
          if (record.fromLoad) return false;
          if (!record.hasExplicitPaths) return false;
          return isCachedModuleAtUrl(loader._cache, record.resolvedParent, importerUrl);
        },
        exit(): void {
          if (record.exited) return;
          record.exited = true;
          const idx = turnStack.lastIndexOf(record);
          if (idx !== -1) turnStack.splice(idx, 1);
        },
      };
    },
    restore(): void {
      loader._load = originalLoad;
      loader._resolveFilename = originalResolveFilename;
      if (loader.prototype !== undefined && typeof originalPrototypeLoad === 'function') {
        loader.prototype.load = originalPrototypeLoad;
      }
    },
  };
}
