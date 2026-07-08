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

const ALIASES: Record<PreviewModuleId, AliasSpec> = {
  react: {
    kind: 'reexport',
    exports: [
      'default',
      'useState',
      'useEffect',
      'useMemo',
      'useCallback',
      'useRef',
      'useReducer',
      'useContext',
      'createContext',
      'Fragment',
      'StrictMode',
      'Children',
      'cloneElement',
      'createElement',
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
  'firebase/firestore': {
    kind: 'reexport',
    exports: [
      'getFirestore',
      'onSnapshot',
      'collection',
      'collectionGroup',
      'doc',
      'getDoc',
      'getDocs',
      'setDoc',
      'addDoc',
      'updateDoc',
      'deleteDoc',
      'query',
      'where',
      'or',
      'and',
      'orderBy',
      'limit',
      'limitToLast',
      'startAt',
      'startAfter',
      'endAt',
      'endBefore',
      'runTransaction',
      'writeBatch',
      'serverTimestamp',
      'increment',
      'arrayUnion',
      'arrayRemove',
      'deleteField',
      'FieldValue',
      'Timestamp',
      'refEqual',
      'queryEqual',
      'snapshotEqual',
    ],
  },
  'firebase/auth': {
    kind: 'reexport',
    exports: [
      'getAuth',
      'connectAuthEmulator',
      'onAuthStateChanged',
      'onIdTokenChanged',
      'signInAnonymously',
      'signInWithEmailAndPassword',
      'createUserWithEmailAndPassword',
      'signOut',
      'setPersistence',
      'signInWithPopup',
      'signInWithCredential',
      'signInWithRedirect',
      'getRedirectResult',
      'getIdToken',
      'getIdTokenResult',
      'GoogleAuthProvider',
      'EmailAuthProvider',
      'FacebookAuthProvider',
      'GithubAuthProvider',
      'OAuthProvider',
      'browserLocalPersistence',
      'browserSessionPersistence',
      'inMemoryPersistence',
      // Preview-only escape hatch: the `sandbox` namespace (seedUsers,
      // setUser, mockSignInResult) lets preview tests pre-stage
      // test users with customClaims. NOT shipped in deploy bundles —
      // see preview-scope.ts for the safety analysis.
      'sandbox',
    ],
  },
  // `firebase/database` modular SDK — aliased to `@pyric/rtdb` at
  // preview-bundle time (Phase 3 Tier 5). Excludes the `sandbox.*`
  // test driver namespace — that's runner-side only, not app code.
  // The exported list mirrors `@pyric/rtdb`'s modular surface as of
  // Phase 3 Tier 1 (the foundation merged on main as PR #431);
  // higher-tier additions (child-event listeners, query constraints)
  // can be added here as they ship in `packages/rtdb/src/modular.ts`.
  'firebase/database': {
    kind: 'reexport',
    exports: [
      'getDatabase',
      'ref',
      'child',
      'get',
      'set',
      'update',
      'remove',
      'push',
      'onValue',
      'off',
      'serverTimestamp',
      'connectDatabaseEmulator',
    ],
  },
  './firebase': { kind: 'reexport', exports: ['db'] },
};

const VIRTUAL_NAMESPACE = 'pyric-preview-virtual';

function synthesizeReexport(specifier: PreviewModuleId, exports: readonly string[]): string {
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

function synthesizeModule(specifier: PreviewModuleId): string {
  const spec = ALIASES[specifier];
  switch (spec.kind) {
    case 'reexport':
      return synthesizeReexport(specifier, spec.exports);
    case 'stub':
      return synthesizeStub(spec.message);
  }
}

export function virtualImportsPlugin(): esbuild.Plugin {
  const aliased = new Set(Object.keys(ALIASES));
  return {
    name: 'pyric-virtual-imports',
    setup(build) {
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
        contents: synthesizeModule(args.path as PreviewModuleId),
        loader: 'js',
      }));
    },
  };
}
