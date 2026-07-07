/**
 * `experiment/app-oracle` — W0 of the workstation benchmarks
 * (plans/agent-capability-epic/workstation-benchmarks.md).
 *
 * Scores the APP HALF of a run's artifact, the half the conformance
 * (rules) oracle is blind to:
 *
 *   compile — every workspace .ts/.tsx transpiles (Bun.Transpiler, tsx)
 *   render  — `/workspace/src/App.tsx`'s default export mounts via
 *             `renderToString` against a real pyric sandbox, with the
 *             canonical preview aliases (`firebase/firestore` →
 *             `pyric/firestore`, `firebase/auth` → `pyric/auth`,
 *             `./firebase` → a generated `{ db }` module) — the same
 *             world the in-browser preview gives the app.
 *
 * Dimensions are reported SEPARATELY and never collapsed into one
 * boolean: collapsing is how the rules-only oracle hid a strategy that
 * could not produce UI at all (conductor log, 2026-06-10).
 *
 * Bun-only (harness scripts already run under bun): TSX import and the
 * runtime module plugin are Bun built-ins, so this adds no deps.
 *
 * Known limits (v1, documented in the benchmarks doc):
 *  - render is a mount smoke (`renderToString`): effects don't run, so
 *    onSnapshot/listener wiring is NOT exercised — that's the future
 *    `behavior` dimension.
 *  - a component that loops forever in render hangs the harness run
 *    (renderToString is synchronous); fixtures are short app prompts and
 *    this has not been observed — revisit with a Worker if it is.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { initializeApp } from 'pyric/app';
import { initializeSandbox } from 'pyric/sandbox';
import * as pyricFirestore from 'pyric/firestore';
import * as pyricAuth from 'pyric/auth';
import * as pyricDatabase from 'pyric/database';

export interface AppOracleScore {
  compile: { ok: boolean; error?: string };
  render: { ok: boolean; error?: string; htmlBytes: number };
}

export interface AppOracleInput {
  /** Workspace files keyed by VFS path (`/workspace/...`). Must include
   *  `/workspace/src/App.tsx` for either dimension to pass. */
  files: Record<string, string>;
}

const APP_ENTRY = '/workspace/src/App.tsx';
const PLAYGROUND_DIR = resolve(import.meta.dir, '..', '..', '..');
const TMP_PARENT = resolve(PLAYGROUND_DIR, 'scripts', 'evals', '.app-oracle');

declare const Bun: typeof import('bun');

/** Per-call sandbox app; the virtual modules' no-arg getters read it
 *  lazily so one static plugin serves every (sequential) invocation. */
let currentApp: unknown = null;
function appForRender(): unknown {
  if (!currentApp) currentApp = initializeApp({ sandbox: initializeSandbox() });
  return currentApp;
}

// Canonical preview aliases as Bun VIRTUAL MODULES (runtime `onResolve`
// does not intercept bare specifiers; `build.module` does). The no-arg
// instance getters bind to the per-call sandbox app, exactly as the
// in-browser preview scope arranges it.
Bun.plugin({
  name: 'app-oracle-firebase-aliases',
  setup(build) {
    build.module('firebase/firestore', () => ({
      loader: 'object',
      exports: {
        ...pyricFirestore,
        getFirestore: (a?: unknown) =>
          pyricFirestore.getFirestore((a ?? appForRender()) as never),
      },
    }));
    build.module('firebase/auth', () => ({
      loader: 'object',
      exports: {
        ...pyricAuth,
        getAuth: (a?: unknown) => pyricAuth.getAuth((a ?? appForRender()) as never),
      },
    }));
    build.module('firebase/database', () => ({
      loader: 'object',
      exports: {
        ...pyricDatabase,
        getDatabase: (a?: unknown) =>
          pyricDatabase.getDatabase((a ?? appForRender()) as never),
      },
    }));
  },
});

/** `./firebase` module the canonical App imports `db` from. Only written
 *  when the workspace didn't author its own. */
const FIREBASE_TS = `import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
export const db = getFirestore();
export const auth = getAuth();
export default { db, auth };
`;

export async function scoreApp(input: AppOracleInput): Promise<AppOracleScore> {
  const score: AppOracleScore = {
    compile: { ok: false },
    render: { ok: false, htmlBytes: 0 },
  };
  const appSource = input.files[APP_ENTRY];
  if (typeof appSource !== 'string' || appSource.trim().length === 0) {
    score.compile.error = 'no /workspace/src/App.tsx produced';
    score.render.error = score.compile.error;
    return score;
  }

  // ── compile: every authored .ts/.tsx transpiles ──────────────────────
  const transpiler = new Bun.Transpiler({ loader: 'tsx' });
  for (const [path, content] of Object.entries(input.files)) {
    if (!/\.(ts|tsx)$/.test(path)) continue;
    try {
      transpiler.transformSync(content);
    } catch (e) {
      score.compile.error = `${path}: ${e instanceof Error ? e.message : String(e)}`;
      score.render.error = 'skipped: compile failed';
      return score;
    }
  }
  score.compile.ok = true;

  // ── render: mount the default export against a sandbox-backed world ──
  mkdirSync(TMP_PARENT, { recursive: true });
  const tmp = mkdtempSync(join(TMP_PARENT, 'run-'));
  try {
    for (const [path, content] of Object.entries(input.files)) {
      if (!path.startsWith('/workspace/src/')) continue;
      const dest = join(tmp, path.slice('/workspace/'.length));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    // Canonical `./firebase` (and `../firebase`) unless the app wrote one.
    if (!input.files['/workspace/src/firebase.ts'] && !input.files['/workspace/src/firebase.tsx']) {
      writeFileSync(join(tmp, 'src', 'firebase.ts'), FIREBASE_TS);
    }
    if (!input.files['/workspace/firebase.ts']) {
      writeFileSync(join(tmp, 'firebase.ts'), FIREBASE_TS);
    }

    // Fresh sandbox app per call — the virtual modules read it lazily.
    currentApp = initializeApp({ sandbox: initializeSandbox() });
    const mod = (await import(pathToFileURL(join(tmp, 'src', 'App.tsx')).href)) as {
      default?: unknown;
    };
    const App = mod.default;
    if (typeof App !== 'function') {
      score.render.error = 'App.tsx has no default-exported component';
      return score;
    }
    const html = renderToString(createElement(App as never));
    score.render.htmlBytes = html.length;
    if (html.trim().length === 0) {
      score.render.error = 'component rendered empty markup';
      return score;
    }
    score.render.ok = true;
    return score;
  } catch (e) {
    score.render.error = e instanceof Error ? e.message : String(e);
    return score;
  } finally {
    currentApp = null;
    rmSync(tmp, { recursive: true, force: true });
  }
}
