/**
 * esbuild plugin that resolves relative imports against the OPFS VFS.
 *
 * Used by both the preview compile and the deploy bundle so a
 * multi-file App TSX project — `App.tsx` plus its `./components/*.tsx`,
 * `./lib/*.ts`, etc. — bundles cleanly without a real on-disk tree.
 *
 * Bare specifiers (`react`, `firebase/firestore`, user-installed
 * packages) are handled by `virtualImportsPlugin` and `cdnImportPlugin`
 * upstream; this plugin only takes paths the others skipped — those
 * starting with `./` or `../`, plus absolute paths under `/workspace/`.
 *
 * Loaded files take their CodeMirror flavor from the extension:
 *   - `.tsx` / `.ts` → `tsx` loader (TypeScript + JSX)
 *   - `.js` / `.mjs` → `js`
 *   - `.json`        → `json`
 *   - `.css`         → `css`
 *
 * Anything else is treated as `text` so the user can import a doc
 * or fixture file without esbuild blowing up.
 */
import type { Loader, Plugin } from 'esbuild-wasm';

import { WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

const VFS_NAMESPACE = 'pyric-vfs';

function loaderForPath(path: string): Loader {
  if (path.endsWith('.tsx') || path.endsWith('.ts')) return 'tsx';
  if (path.endsWith('.jsx')) return 'jsx';
  if (path.endsWith('.mjs') || path.endsWith('.js') || path.endsWith('.cjs')) return 'js';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.css')) return 'css';
  return 'text';
}

function resolveRelative(importer: string, specifier: string): string {
  const base = importer ? importer.slice(0, importer.lastIndexOf('/')) : WORKSPACE_ROOT;
  const parts = base.split('/').filter(Boolean);
  for (const segment of specifier.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return `/${parts.join('/')}`;
}

/**
 * Pick the first existing variant for a specifier the import omitted
 * the extension on. Mirrors node-style resolution against the VFS.
 */
async function pickFile(candidates: string[]): Promise<string | null> {
  const adapter = getVFS();
  for (const candidate of candidates) {
    try {
      const stat = await adapter.promises.lstat(candidate);
      if (stat.isFile()) return candidate;
      if (stat.isDirectory()) {
        const nested = await pickFile([
          `${candidate}/index.tsx`,
          `${candidate}/index.ts`,
          `${candidate}/index.jsx`,
          `${candidate}/index.js`,
          `${candidate}/index.mjs`,
        ]);
        if (nested) return nested;
      }
    } catch {
      // not found — try the next candidate
    }
  }
  return null;
}

async function resolvePath(importer: string, specifier: string): Promise<string | null> {
  const isAbsolute = specifier.startsWith('/');
  const base = isAbsolute ? specifier : resolveRelative(importer, specifier);
  if (!base.startsWith(`${WORKSPACE_ROOT}/`) && base !== WORKSPACE_ROOT) {
    return null;
  }
  return pickFile([
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.json`,
    `${base}.css`,
  ]);
}

export function vfsLoadPlugin(): Plugin {
  return {
    name: 'pyric-vfs-load',
    setup(build) {
      // Relative paths from any importer (including the virtual entry
      // which carries the abs path of the file it stands in for).
      build.onResolve({ filter: /^[./]/ }, async (args) => {
        const importer = args.importer ?? '';
        // The virtual `./firebase` deploy hook gets its own resolver
        // upstream; leave that one alone so it stays in the virtual
        // namespace and isn't shadowed by an absent /workspace/firebase.
        if (args.path === './firebase') return null;
        const resolved = await resolvePath(importer, args.path);
        if (!resolved) return null;
        return { path: resolved, namespace: VFS_NAMESPACE };
      });
      // Absolute paths under /workspace/ — the entry path resolution
      // hits this branch.
      build.onResolve({ filter: /^\/workspace\// }, async (args) => {
        const resolved = await resolvePath('', args.path);
        if (!resolved) return null;
        return { path: resolved, namespace: VFS_NAMESPACE };
      });
      build.onLoad({ filter: /.*/, namespace: VFS_NAMESPACE }, async (args) => {
        const adapter = getVFS();
        const value = await adapter.promises.readFile(args.path, 'utf8');
        const contents = typeof value === 'string' ? value : new TextDecoder().decode(value);
        return { contents, loader: loaderForPath(args.path) };
      });
    },
  };
}
