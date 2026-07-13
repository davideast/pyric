/**
 * In-browser TSX → JS compile for the App preview. Uses
 * `esbuild-wasm` with a virtual-imports plugin so the user's
 * `appSource` can use canonical `firebase/firestore` / `react`
 * imports — the same shape a production build sees — while the
 * preview routes those imports to pyric values supplied through
 * `globalThis.__pyricPreview__`.
 *
 * The user writes a small TSX module with canonical imports and a
 * default export — typically:
 *
 *   import { useState } from 'react';
 *   import { collection, getDocs } from 'firebase/firestore';
 *   import { db } from './firebase';
 *   export default function App() { … }
 *
 * `compileApp(source)` returns a factory that, when called, evaluates
 * the bundled IIFE and returns the default export.
 */

import type { Plugin, PluginBuild } from 'esbuild-wasm';

import { cdnImportPlugin, getImportMap } from '~/lib/packages';
import { APP_ENTRY_PATH } from '~/lib/store/files';

import { getEsbuild } from './esbuild-service';
import { installPreviewScope, type PreviewScope } from './preview-scope';
import { vfsLoadPlugin } from './vfs-load-plugin';
import { virtualImportsPlugin } from './virtual-imports-plugin';

// Entry path inside the OPFS VFS. The string passed into compileApp
// is the entry file's content; relative imports inside it resolve
// against this path through `vfsLoadPlugin`.
const ENTRY_PATH = APP_ENTRY_PATH;
const ENTRY_NAMESPACE = 'pyric-preview-entry';
const GLOBAL_NAME = '__pyricCompiledApp__';
const REQUIRE_GLOBAL = '__pyricPreviewRequire__';

export interface CompileSuccess {
  ok: true;
  /**
   * Run the compiled bundle and return the default export. Caller
   * supplies the scope — installed on `globalThis.__pyricPreview__`
   * just before the bundle executes, replaced atomically each call.
   */
  evaluate: (scope: PreviewScope, sandboxHandle: unknown) => unknown;
}

export interface CompileFailure {
  ok: false;
  message: string;
  line?: number;
  column?: number;
}

export type CompileResult = CompileSuccess | CompileFailure;

export async function compileApp(source: string): Promise<CompileResult> {
  let esbuild: Awaited<ReturnType<typeof getEsbuild>>;
  try {
    esbuild = await getEsbuild();
  } catch (e) {
    return {
      ok: false,
      message: `esbuild-wasm init failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Plugin that injects the user's source under the entry's VFS path.
  // The entry's `source` is passed in by the caller so AppPreview can
  // recompile on every edit without round-tripping back through OPFS
  // (the FileEditor already wrote it). All relative imports from the
  // entry resolve via `vfsLoadPlugin` against the same path.
  const entryPlugin: Plugin = {
    name: 'pyric-preview-entry',
    setup(build: PluginBuild) {
      build.onResolve({ filter: new RegExp(`^${escapeRegex(ENTRY_PATH)}$`) }, () => ({
        path: ENTRY_PATH,
        namespace: ENTRY_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: ENTRY_NAMESPACE }, () => ({
        contents: source,
        loader: 'tsx' as const,
      }));
    },
  };

  // Snapshot the user's installed-package import map up front. esbuild
  // plugin hooks can't do async I/O, so the CDN plugin must receive
  // the resolved map synchronously at construction.
  let userImportMap: Record<string, string> = {};
  try {
    userImportMap = await getImportMap();
  } catch {
    // Missing or unreadable map is non-fatal — preview falls back to
    // the built-in virtual-imports surface.
    userImportMap = {};
  }

  const hasCdnImports = Object.keys(userImportMap).length > 0;

  let result: Awaited<ReturnType<typeof esbuild.build>>;
  try {
    result = await esbuild.build({
      entryPoints: [ENTRY_PATH],
      bundle: true,
      write: false,
      format: 'iife',
      globalName: GLOBAL_NAME,
      jsx: 'automatic',
      jsxImportSource: 'react',
      logLevel: 'silent',
      plugins: [
        entryPlugin,
        virtualImportsPlugin(),
        cdnImportPlugin(userImportMap),
        vfsLoadPlugin(),
      ],
      // When the user has installed packages, esbuild's IIFE output
      // turns each `external: true` import into a synchronous
      // `require(...)` call. Hoist a script-scoped alias for that
      // shim onto the eval scope so the IIFE finds it.
      ...(hasCdnImports
        ? { banner: { js: `const require = globalThis['${REQUIRE_GLOBAL}'];` } }
        : {}),
    });
  } catch (e) {
    return {
      ok: false,
      message: formatBuildError(e),
      ...extractLocation(e),
    };
  }

  // Pre-load installed CDN packages once so the require shim is
  // synchronous from the IIFE's perspective. The map is captured here
  // and closed over by `evaluate`.
  let cdnModules: Map<string, unknown> = new Map();
  if (hasCdnImports) {
    try {
      cdnModules = await preloadCdnModules(userImportMap);
    } catch (e) {
      return {
        ok: false,
        message: `Failed to load installed packages from esm.sh: ${
          e instanceof Error ? e.message : String(e)
        }`,
      };
    }
  }

  const out = result.outputFiles?.[0];
  if (!out) {
    return { ok: false, message: 'esbuild produced no output' };
  }

  const code = out.text;

  return {
    ok: true,
    evaluate: (scope, sandboxHandle) => {
      installPreviewScope({ ...scope, __sandbox: sandboxHandle as never });
      if (hasCdnImports) {
        (globalThis as Record<string, unknown>)[REQUIRE_GLOBAL] = (name: string) => {
          const mod = cdnModules.get(name);
          if (!mod) {
            throw new Error(
              `Installed package '${name}' was not loaded into the preview scope.`,
            );
          }
          return mod;
        };
      }
      // SECURITY (issue #767, deferred): this `globalThis.eval` runs
      // agent-authored / GitHub-imported `appSource` in the PARENT
      // realm, giving it the parent origin's `localStorage` / tokens.
      // The correct fix is a cross-origin sandboxed iframe with a
      // `postMessage` data plane (see the PR body for #767) — a large
      // re-architecture that would break the current React-instance +
      // live-`sandbox`/`db` closure sharing, so it's tracked separately
      // rather than half-implemented here. Note: adding a `sandbox`
      // attribute to the presentation iframe does NOT mitigate this —
      // the untrusted code executes here in the parent, not in the
      // iframe.
      //
      // The IIFE wraps as `var GLOBAL_NAME = (() => { … })()`. We must
      // evaluate at global scope so the top-level `var` becomes a
      // property on globalThis; `new Function(code)()` would scope it
      // to the function body. `globalThis.eval` is an indirect eval
      // form (the call site doesn't reference the `eval` identifier
      // directly) and runs in global scope — same effect as the
      // `(0, eval)` trick without the comma-operator TS warning.
      delete (globalThis as Record<string, unknown>)[GLOBAL_NAME];
      (globalThis.eval as (src: string) => unknown)(code);
      const mod = (globalThis as Record<string, unknown>)[GLOBAL_NAME] as
        | { default?: unknown }
        | undefined;
      return mod?.default ?? null;
    },
  };
}

/**
 * Eager dynamic-import of every installed CDN module. Runs once per
 * compile so subsequent `evaluate` calls don't re-fetch. Browsers
 * cache module fetches anyway, but this also primes esbuild's
 * synchronous `require(...)` call site with a real exports object.
 */
async function preloadCdnModules(
  importMap: Record<string, string>,
): Promise<Map<string, unknown>> {
  const entries = await Promise.all(
    Object.entries(importMap).map(async ([name, url]) => {
      const mod = (await import(/* @vite-ignore */ url)) as unknown;
      return [name, mod] as const;
    }),
  );
  return new Map(entries);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatBuildError(e: unknown): string {
  if (typeof e === 'object' && e && 'errors' in e) {
    const errors = (e as { errors: Array<{ text: string; location?: unknown }> }).errors;
    if (errors.length > 0) return errors.map((err) => err.text).join('\n');
  }
  return e instanceof Error ? e.message : String(e);
}

function extractLocation(e: unknown): { line?: number; column?: number } {
  if (typeof e === 'object' && e && 'errors' in e) {
    const first = (e as { errors: Array<{ location?: { line: number; column: number } }> })
      .errors[0];
    if (first?.location) {
      return { line: first.location.line, column: first.location.column };
    }
  }
  return {};
}
