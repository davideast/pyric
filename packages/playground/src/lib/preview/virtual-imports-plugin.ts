/**
 * esbuild plugin that resolves a configured set of import specifiers
 * to synthetic modules. Two behaviors:
 *
 *   - `reexport` — synthesize a module that re-exports named members
 *     from `globalThis.__pyricPreview__`. This is the seam that lets
 *     the user write canonical `firebase/firestore` imports while the
 *     playground supplies pyric-flavored values at runtime.
 *   - `stub` — synthesize a module whose default export is a Proxy
 *     that throws on any access, with a configured message. Used for
 *     specifiers we want to deny explicitly. (Currently unused; kept
 *     for future deny-list cases.)
 *
 * The `reexport` export list must match what `preview-scope.ts`
 * actually provides on the global. Mismatches surface as `undefined`
 * at runtime — keep them in lockstep.
 */

import type * as esbuild from 'esbuild-wasm';

import { PREVIEW_GLOBAL, type PreviewModuleId } from './preview-scope';

type AliasSpec =
  | { kind: 'reexport'; exports: readonly string[] }
  | { kind: 'stub'; message: string };

const ALIASES: Record<string, AliasSpec> = {
  react: {
    kind: 'reexport',
    exports: [
      'default',
      'useState',
      'useEffect',
      'useMemo',
      'useCallback',
      'useRef',
      'useId',
      'useLayoutEffect',
      'useInsertionEffect',
      'useSyncExternalStore',
      'useTransition',
      'useDeferredValue',
      'useReducer',
      'useContext',
      'createContext',
      'Fragment',
      'StrictMode',
      'Children',
      'cloneElement',
      'createElement',
      'Component',
      'PureComponent',
      'Suspense',
      'lazy',
      'isValidElement',
      'memo',
      'forwardRef',
    ],
  },
  // Automatic JSX runtime — `esbuild` with `jsx: 'automatic'` emits
  // `import { jsx, jsxs, Fragment } from 'react/jsx-runtime'` (and
  // the dev variant). Both must resolve or any JSX in the user's
  // module fails to bundle.
  'react/jsx-runtime': { kind: 'reexport', exports: ['jsx', 'jsxs', 'Fragment'] },
  'react/jsx-dev-runtime': { kind: 'reexport', exports: ['jsxDEV', 'Fragment'] },
  'react-dom': {
    kind: 'reexport',
    exports: ['default', 'createPortal', 'flushSync', 'preconnect', 'prefetchDNS', 'preinit', 'preload'],
  },
  'react-dom/client': { kind: 'reexport', exports: ['createRoot', 'hydrateRoot'] },
  '@pyric/cli/conformance/browser': {
    kind: 'reexport',
    exports: ['canIUse', 'createCanIUseTool'],
  },
  './firebase': { kind: 'reexport', exports: ['db'] },
};

const VIRTUAL_NAMESPACE = 'pyric-preview-virtual';

function synthesizeReexport(specifier: string, exports: readonly string[]): string {
  const head = `const __m = globalThis['${PREVIEW_GLOBAL}']?.['${specifier}'];`;
  const guard = `if (!__m) throw new Error("preview scope missing module: ${specifier}");`;
  const lines = exports
    .filter((name) => name !== 'default')
    .map((name) => `export const ${name} = __m.${name};`);
  const defaultLine = exports.includes('default')
    ? `export default __m.default ?? __m;`
    : `export default __m;`;
  return [head, guard, ...lines, defaultLine].join('\n');
}

function synthesizeStub(message: string): string {
  // JSON-encode the message so newlines / quotes survive into the
  // synthesized module's string literal.
  const encoded = JSON.stringify(message);
  return [
    `const stub = new Proxy({}, {`,
    `  get(_t, prop) {`,
    `    throw new Error(${encoded} + ' Attempted access: ' + String(prop));`,
    `  },`,
    `});`,
    `export default stub;`,
  ].join('\n');
}

function synthesizeModule(specifier: string): string {
  const spec = ALIASES[specifier];
  switch (spec.kind) {
    case 'reexport':
      return synthesizeReexport(specifier, spec.exports);
    case 'stub':
      return synthesizeStub(spec.message);
  }
}

/** Every Firebase Web SDK subpath is selected through the Pyric mirror. */
export function mapFirebaseImport(specifier: string): PreviewModuleId | null {
  if (!specifier.startsWith('firebase/')) return null;
  return `pyric/${specifier.slice('firebase/'.length)}` as PreviewModuleId;
}

function synthesizePyricModule(specifier: PreviewModuleId): string {
  const head = `const __m = globalThis['${PREVIEW_GLOBAL}']?.['${specifier}'];`;
  const guard = `if (!__m) throw new Error("No Playground preview mirror is installed for ${specifier}");`;
  // CommonJS is intentional: esbuild permits arbitrary named imports from a
  // dynamic CommonJS object, so every export Pyric adds becomes available
  // without another hand-maintained export allow-list here.
  return [head, guard, 'module.exports = __m;'].join('\n');
}

export function virtualImportsPlugin(): esbuild.Plugin {
  const aliased = new Set(Object.keys(ALIASES));
  return {
    name: 'pyric-virtual-imports',
    setup(build) {
      build.onResolve({ filter: /^firebase\// }, (args) => ({
        path: mapFirebaseImport(args.path)!,
        namespace: VIRTUAL_NAMESPACE,
      }));
      build.onResolve({ filter: /^[^.]/ }, (args) => {
        if (aliased.has(args.path)) {
          return { path: args.path, namespace: VIRTUAL_NAMESPACE };
        }
        return null;
      });
      build.onResolve({ filter: /^\.\/firebase$/ }, (args) => ({
        path: args.path,
        namespace: VIRTUAL_NAMESPACE,
      }));
      build.onLoad({ filter: /.*/, namespace: VIRTUAL_NAMESPACE }, (args) => ({
        contents: args.path.startsWith('pyric/')
          ? synthesizePyricModule(args.path as PreviewModuleId)
          : synthesizeModule(args.path),
        loader: 'js',
      }));
    },
  };
}
