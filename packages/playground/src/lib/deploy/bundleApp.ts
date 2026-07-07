/**
 * Bundle the workspace `appSource` into a two-file static artifact
 * (`index.html` + `assets/main-<hash>.js`) suitable for Firebase
 * Hosting. Pure async function — no React, no store access. Used by
 * `useHostingDeploy` for the per-track button and by `useDeployAll`
 * for the orchestrating button.
 *
 * Mirrors `playground-template/src/main.tsx` (init Firebase app from
 * config, render the App default export) but inlines the config + a
 * single virtual entry rather than fetching the multi-file template
 * over the dev server.
 *
 * **Runtime deps via import map, not bundled.** `react`, `react-dom`,
 * and `firebase/*` are marked `external` to esbuild — the deploy
 * bundle ships ES-module imports against bare specifiers. The HTML
 * shell emits an import map that points those specifiers at esm.sh
 * (matching `playground-template/package.json`'s versions), so the
 * browser fetches the real modules at first paint. This keeps the
 * deploy bundle tiny (just the user's TSX + a few lines of bootstrap)
 * and avoids needing a node_modules tree at bundle time in the
 * browser, which esbuild-wasm can't walk.
 *
 * **Metafile gate.** The agent prompt forbids `@pyric/*` imports in
 * `appSource` and the template's package.json doesn't depend on
 * pyric. As a belt-and-suspenders backstop, this module asks esbuild
 * for a metafile, scans the input set for any module path matching
 * `/@pyric/`, and throws `PyricLeakError` before returning the
 * bundle. The deploy hooks surface the throw as an error state; the
 * user never ships a build with pyric internals in it.
 */
import type { Metafile, Plugin } from 'esbuild-wasm';

import { cdnImportPlugin, getImportMap } from '~/lib/packages';
import { getEsbuild } from '~/lib/preview/esbuild-service';
import { vfsLoadPlugin } from '~/lib/preview/vfs-load-plugin';
import type { DeployTarget } from '~/lib/store/workspace';

const ENCODER = new TextEncoder();

/**
 * Runtime dependency versions. Match `playground-template/package.json`
 * so users get the same React / Firebase the template builds against.
 * Pinned (not `latest`) so a CDN release doesn't silently change
 * what their deployed app runs.
 */
const REACT_VERSION = '18.3.1';
const FIREBASE_VERSION = '12.12.0';

/**
 * esbuild externals — bare specifiers we expect the browser to
 * resolve via the import map. Patterns include subpath imports
 * (`firebase/firestore`, `react-dom/client`, `react/jsx-runtime`, etc.).
 */
const EXTERNAL_SPECIFIERS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'firebase/app',
  'firebase/firestore',
  'firebase/auth',
  'firebase/storage',
  'firebase/database',
  'firebase/functions',
];

export interface BundleAppInput {
  appSource: string;
  firebaseConfig: DeployTarget['firebaseConfig'];
  projectId: string;
}

export interface BundledFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * Thrown by `bundleAppToHostingFiles` when the metafile gate detects
 * any `/@pyric/` module in the bundle's input set. The deploy hooks
 * surface this as a hard error — no upload happens.
 */
export class PyricLeakError extends Error {
  constructor(
    message: string,
    /** Module paths from the esbuild metafile that matched `/@pyric/`. */
    public readonly offendingModules: string[],
  ) {
    super(message);
    this.name = 'PyricLeakError';
  }
}

/** Pattern the metafile gate refuses. Matches any `/@pyric/` segment. */
const PYRIC_LEAK_PATTERN = /\/@pyric\//;

export async function bundleAppToHostingFiles(
  input: BundleAppInput,
): Promise<BundledFile[]> {
  const esbuild = await getEsbuild();

  const config = resolveFirebaseConfig(input.firebaseConfig, input.projectId);
  const entrySource = buildEntrySource();
  const firebaseVirtualSource = buildFirebaseVirtualSource(config);

  const VIRTUAL_NS = 'pyric-deploy-virtual';
  const ENTRY_PATH = 'pyric-deploy-entry.tsx';
  const APP_PATH = 'pyric-deploy-app.tsx';
  const FIREBASE_PATH = 'pyric-deploy-firebase.ts';

  const entryPlugin: Plugin = {
    name: 'pyric-deploy-entry',
    setup(build) {
      build.onResolve({ filter: /^pyric-deploy-(entry|app)\.tsx$/ }, (args) => ({
        path: args.path,
        namespace: VIRTUAL_NS,
      }));
      // Resolve `./firebase` (with optional .ts/.tsx) imported FROM
      // the virtual entry OR app module to our virtual firebase module.
      // The playground template's source tree has a `src/firebase.ts`
      // that exports `db`; the deploy bundle ships the same shape plus
      // the `initializeApp` call (see buildFirebaseVirtualSource).
      build.onResolve(
        { filter: /^\.\/firebase(\.tsx?)?$/, namespace: VIRTUAL_NS },
        () => ({ path: FIREBASE_PATH, namespace: VIRTUAL_NS }),
      );
      build.onLoad({ filter: /.*/, namespace: VIRTUAL_NS }, (args) => {
        if (args.path === ENTRY_PATH) return { contents: entrySource, loader: 'tsx' as const };
        if (args.path === APP_PATH) return { contents: input.appSource, loader: 'tsx' as const };
        if (args.path === FIREBASE_PATH) return { contents: firebaseVirtualSource, loader: 'ts' as const };
        return null;
      });
    },
  };

  // User-installed packages: pull the persisted import map and merge
  // it with the static set. The CDN plugin tags those specifiers as
  // external so esbuild leaves the bare imports in the output and the
  // HTML shell's import map handles resolution at runtime.
  let userImportMap: Record<string, string> = {};
  try {
    userImportMap = await getImportMap();
  } catch {
    userImportMap = {};
  }

  const result = await esbuild.build({
    entryPoints: [ENTRY_PATH],
    bundle: true,
    write: false,
    // ESM so we can ship bare-specifier imports the import map resolves.
    format: 'esm',
    jsx: 'automatic',
    jsxImportSource: 'react',
    minify: true,
    logLevel: 'silent',
    target: ['es2020'],
    plugins: [entryPlugin, cdnImportPlugin(userImportMap), vfsLoadPlugin()],
    external: EXTERNAL_SPECIFIERS,
    metafile: true,
  });

  // Metafile gate — refuse to return a bundle that contains any
  // `@pyric/*` module. The agent's prompt rules already forbid those
  // imports in `appSource`; this is the last-line safety check that
  // fails closed if anything slipped through.
  if (result.metafile) {
    assertNoPyricLeak(result.metafile);
  }

  const out = result.outputFiles?.[0];
  if (!out) throw new Error('esbuild produced no output');

  const jsBytes = ENCODER.encode(out.text);
  const jsHash = await sha256HexShort(jsBytes);
  const jsPath = `/assets/main-${jsHash}.js`;

  const html = buildHtmlShell(jsPath, userImportMap);
  const htmlBytes = ENCODER.encode(html);

  return [
    { path: '/index.html', bytes: htmlBytes },
    { path: jsPath, bytes: jsBytes },
  ];
}

interface ResolvedFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}

function resolveFirebaseConfig(
  cfg: DeployTarget['firebaseConfig'],
  projectId: string,
): ResolvedFirebaseConfig {
  if (!cfg) {
    return { apiKey: '', authDomain: '', projectId };
  }
  return {
    apiKey: cfg.apiKey,
    authDomain: cfg.authDomain,
    projectId: cfg.projectId || projectId,
    ...(cfg.storageBucket ? { storageBucket: cfg.storageBucket } : {}),
    ...(cfg.messagingSenderId ? { messagingSenderId: cfg.messagingSenderId } : {}),
    ...(cfg.appId ? { appId: cfg.appId } : {}),
  };
}

/**
 * The virtual `./firebase` module the deploy bundle loads when app
 * code does `import { db } from "./firebase"`. Self-initializes the
 * Firebase app on first import — the user's `firebaseConfig` is
 * inlined here at bundle time, and an idempotent `getApps().length`
 * check tolerates HMR / repeat imports.
 *
 * Why config lives HERE and not in the entry source: ESM hoists all
 * imports before any top-level code runs. If the entry calls
 * `initializeApp(firebaseConfig)` after `import App from '...'`, the
 * app's transitive `import { db } from './firebase'` evaluates
 * FIRST — and a `getFirestore(getApp())` at the top of `./firebase`
 * throws `app/no-app` because no app exists yet. By moving
 * `initializeApp` into `./firebase` and gating it with
 * `getApps().length === 0`, any caller that imports `./firebase`
 * is guaranteed to see an initialized app, no matter the load order.
 */
function buildFirebaseVirtualSource(config: ResolvedFirebaseConfig): string {
  const configLiteral = JSON.stringify(config);
  return [
    `import { initializeApp, getApps, getApp } from 'firebase/app';`,
    `import { getFirestore } from 'firebase/firestore';`,
    ``,
    `const firebaseConfig = ${configLiteral};`,
    `const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();`,
    ``,
    `export const db = getFirestore(app);`,
    ``,
  ].join('\n');
}

function buildEntrySource(): string {
  // Entry stays minimal — no Firebase bootstrap here. Importing
  // `./firebase` (transitively via App, or directly if App doesn't)
  // initializes the Firebase app via `getApps().length === 0` check.
  // App code that calls `getAuth()` or `getFirestore()` with no args
  // picks up the default app the same way.
  return [
    `import * as React from 'react';`,
    `import { createRoot } from 'react-dom/client';`,
    `import './firebase';`,
    `import App from 'pyric-deploy-app.tsx';`,
    ``,
    `const root = document.getElementById('root');`,
    `if (!root) throw new Error('#root not found');`,
    `createRoot(root).render(React.createElement(React.StrictMode, null, React.createElement(App)));`,
  ].join('\n');
}

/**
 * The import map shipped in the HTML. Resolves every bare specifier
 * the deploy bundle emits to its CDN URL with the same version
 * `playground-template/package.json` declares.
 *
 * React + react-dom come from esm.sh (small surface, no shared
 * singletons to worry about). Firebase comes from `gstatic`'s
 * official browser ESM bundles: they're built as a coordinated set
 * that shares one copy of `@firebase/component`'s service registry
 * across all entrypoints. `esm.sh`-served Firebase modules each
 * inline their own copy of `@firebase/component`, so `firebase/app`
 * and `firebase/firestore` end up with separate registries and
 * `getFirestore(app)` fails at runtime with "Service firestore is
 * not available". A virtual-fs + esbuild-wasm approach that bundles
 * Firebase's raw npm source into the deploy JS is the longer-term
 * plan (hermetic deploys, no third-party runtime CDN); this CDN
 * choice is the bridge until that ships.
 */
function buildImportMap(extraImports: Record<string, string> = {}): string {
  const r = `https://esm.sh/react@${REACT_VERSION}`;
  const rd = `https://esm.sh/react-dom@${REACT_VERSION}`;
  const fb = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const baseImports: Record<string, string> = {
    react: r,
    'react/jsx-runtime': `${r}/jsx-runtime`,
    'react/jsx-dev-runtime': `${r}/jsx-dev-runtime`,
    'react-dom': rd,
    'react-dom/client': `${rd}/client`,
    'firebase/app': `${fb}/firebase-app.js`,
    'firebase/firestore': `${fb}/firebase-firestore.js`,
    'firebase/auth': `${fb}/firebase-auth.js`,
    'firebase/storage': `${fb}/firebase-storage.js`,
    'firebase/database': `${fb}/firebase-database.js`,
    'firebase/functions': `${fb}/firebase-functions.js`,
  };
  // User-installed packages win against the built-in set only if they
  // target a specifier the static map doesn't own. Static keys take
  // precedence to keep React/Firebase versions pinned.
  const merged: Record<string, string> = { ...extraImports, ...baseImports };
  return JSON.stringify({ imports: merged }, null, 2);
}

function buildHtmlShell(jsPath: string, extraImports: Record<string, string> = {}): string {
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `  <meta charset="utf-8" />`,
    `  <meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `  <title>Pyric playground app</title>`,
    `  <script type="importmap">`,
    buildImportMap(extraImports),
    `  </script>`,
    `</head>`,
    `<body>`,
    `  <div id="root"></div>`,
    `  <script type="module" src="${jsPath}"></script>`,
    `</body>`,
    `</html>`,
    ``,
  ].join('\n');
}

/**
 * Throw `PyricLeakError` if any module in the metafile's input set
 * has a path matching `/@pyric/`. Checks both `inputs` (every
 * module esbuild touched) and the `imports` arrays inside each
 * input (transitive deps). Covers `node_modules/@pyric/...` and bare
 * `@pyric/...` specifiers alike.
 */
function assertNoPyricLeak(metafile: Metafile): void {
  const matches = new Set<string>();
  for (const inputPath of Object.keys(metafile.inputs)) {
    if (PYRIC_LEAK_PATTERN.test(inputPath) || inputPath.startsWith('@pyric/')) {
      matches.add(inputPath);
    }
    for (const imp of metafile.inputs[inputPath]?.imports ?? []) {
      if (PYRIC_LEAK_PATTERN.test(imp.path) || imp.path.startsWith('@pyric/')) {
        matches.add(imp.path);
      }
    }
  }
  if (matches.size === 0) return;
  const sorted = [...matches].sort();
  throw new PyricLeakError(
    `Refused to ship a bundle that imports @pyric/* (${sorted.length} ${
      sorted.length === 1 ? 'module' : 'modules'
    }): ${sorted.join(', ')}. The agent prompt forbids @pyric/* imports in appSource; check the source you're deploying.`,
    sorted,
  );
}

async function sha256HexShort(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const view = new Uint8Array(digest);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += view[i].toString(16).padStart(2, '0');
  }
  return out;
}
