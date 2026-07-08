/**
 * Probe a cloned (or seeded) VFS tree for playground workspace compatibility.
 *
 * Used before opening a session from GitHub: structural discovery, package.json
 * framework guards, and a light import scan on the app entry. Does not run
 * compile or rules lint — callers can layer `compileApp` / `lintFirestoreRules
 * on a green/yellow result for a stronger gate.
 *
 * See plans/clone-from-github.md.
 */
import { listAllFiles } from '~/lib/files/file-tree';
import {
  APP_ENTRY_PATH,
  RULES_PATH,
  WORKSPACE_ROOT,
} from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

export type WorkspaceProbeTier = 'green' | 'yellow' | 'red';

/** Known repo shapes relative to a detected content root. */
export type WorkspaceLayoutKind =
  | 'playground-native'
  | 'playground-template'
  | 'pyric-init-web'
  | 'nested-clone'
  | 'unknown';

export interface WorkspaceFileMappings {
  /** Directory containing the discovered project files (may != WORKSPACE_ROOT). */
  contentRoot: string;
  /** Absolute VFS path to rules source file. */
  rulesPath: string;
  /** Absolute VFS path to React app entry. */
  appEntryPath: string;
  /** Canonical playground targets after materialize. */
  canonical: {
    rulesPath: typeof RULES_PATH;
    appEntryPath: typeof APP_ENTRY_PATH;
  };
  testPaths: string[];
}

export interface WorkspaceProbeResult {
  tier: WorkspaceProbeTier;
  layout: WorkspaceLayoutKind;
  blockers: string[];
  warnings: string[];
  mappings: WorkspaceFileMappings | null;
}

export interface WorkspaceProbeInput {
  /** VFS root to scan. Defaults to {@link WORKSPACE_ROOT}. */
  root?: string;
  /** Override file listing (tests). */
  listFiles?: (root: string) => Promise<string[]>;
  /** Read UTF-8 file contents; return null when missing. */
  readFile: (path: string) => Promise<string | null>;
}

/** package.json dependency names that imply a non-playground stack. */
export const BLOCKED_FRAMEWORK_DEPS = [
  'next',
  '@next/env',
  'expo',
  '@expo/metro-runtime',
  '@remix-run/node',
  '@remix-run/react',
  'nuxt',
  '@nuxt/kit',
  '@angular/core',
  'sveltekit',
  '@sveltejs/kit',
] as const;

const RULES_BASENAMES = new Set(['firestore.rules']);

const APP_ENTRY_RELATIVE: readonly { rel: string; kind: WorkspaceLayoutKind }[] = [
  { rel: 'src/App.tsx', kind: 'playground-native' },
  { rel: 'src/App.jsx', kind: 'playground-native' },
  { rel: 'src/generated/app-source.tsx', kind: 'playground-template' },
  { rel: 'public/app.js', kind: 'pyric-init-web' },
];

const TESTS_DIR = 'tests';

/** Bare specifiers allowed in preview without esm.sh install. */
const ALLOWED_BARE_IMPORTS = new Set([
  'react',
  'react-dom',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'firebase/app',
  'firebase/firestore',
  'firebase/auth',
  'firebase/database',
  'firebase/storage',
  'firebase/functions',
]);

const IMPORT_RE =
  /\b(?:import|export)\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function joinPath(base: string, rel: string): string {
  const parts = base.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/**
 * When clone lands in `/workspace/{repo}/…`, find the directory that
 * contains project markers (package.json or firestore.rules).
 */
export function detectContentRoot(allFiles: string[], workspaceRoot: string): string {
  const underRoot = allFiles.filter(
    (p) => p === workspaceRoot || p.startsWith(`${workspaceRoot}/`),
  );
  if (underRoot.length === 0) return workspaceRoot;

  const markerPaths = underRoot.filter((p) => {
    const base = basename(p);
    return base === 'package.json' || RULES_BASENAMES.has(base);
  });

  if (markerPaths.length === 0) return workspaceRoot;

  // Prefer shallowest marker directory.
  markerPaths.sort((a, b) => a.split('/').length - b.split('/').length);
  const marker = markerPaths[0]!;
  const candidate = dirname(marker);
  if (candidate === '/' || !candidate.startsWith(workspaceRoot)) {
    return workspaceRoot;
  }
  return candidate;
}

export function discoverRulesPath(allFiles: string[], contentRoot: string): string | null {
  const direct = joinPath(contentRoot, 'firestore.rules');
  if (allFiles.includes(direct)) return direct;
  for (const p of allFiles) {
    if (basename(p) === 'firestore.rules') return p;
  }
  return null;
}

export function discoverAppEntry(
  allFiles: string[],
  contentRoot: string,
): { path: string; kind: WorkspaceLayoutKind } | null {
  for (const { rel, kind } of APP_ENTRY_RELATIVE) {
    const candidate = joinPath(contentRoot, rel);
    if (allFiles.includes(candidate)) return { path: candidate, kind };
  }
  return null;
}

export function discoverTestPaths(allFiles: string[], contentRoot: string): string[] {
  const prefix = `${joinPath(contentRoot, TESTS_DIR)}/`;
  return allFiles
    .filter((p) => p.startsWith(prefix) && p.endsWith('.test.json'))
    .sort();
}

export function classifyLayout(
  contentRoot: string,
  appKind: WorkspaceLayoutKind | null,
  rulesPath: string | null,
  appPath: string | null,
): WorkspaceLayoutKind {
  if (appKind && appKind !== 'unknown') return appKind;
  if (contentRoot !== WORKSPACE_ROOT) return 'nested-clone';
  if (rulesPath === RULES_PATH && appPath === APP_ENTRY_PATH) return 'playground-native';
  if (rulesPath || appPath) return 'unknown';
  return 'unknown';
}

export function analyzePackageJson(text: string): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push('package.json is present but not valid JSON — skipped framework check.');
    return { blockers, warnings };
  }
  if (!parsed || typeof parsed !== 'object') return { blockers, warnings };

  const deps = {
    ...((parsed as { dependencies?: Record<string, string> }).dependencies ?? {}),
    ...((parsed as { devDependencies?: Record<string, string> }).devDependencies ?? {}),
  };

  for (const name of BLOCKED_FRAMEWORK_DEPS) {
    if (name in deps) {
      blockers.push(
        `package.json depends on "${name}" — playground supports a single-page React + Firestore rules workspace, not this framework stack.`,
      );
    }
  }

  if (!('firebase' in deps)) {
    warnings.push('package.json has no firebase dependency — app may still use canonical firebase/* imports.');
  }

  return { blockers, warnings };
}

/** Light static scan of app entry imports. */
export function scanEntryImports(source: string): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (!spec || seen.has(spec)) continue;
    seen.add(spec);

    if (spec.startsWith('.') || spec.startsWith('/')) continue;

    if (spec.startsWith('node:')) {
      blockers.push(`App entry imports Node built-in "${spec}" — not available in the browser preview.`);
      continue;
    }

    if (spec === 'next' || spec.startsWith('next/') || spec.startsWith('@next/')) {
      blockers.push(`App entry imports "${spec}" — Next.js is not supported in the playground.`);
      continue;
    }

    const nodeBuiltins = ['fs', 'path', 'crypto', 'http', 'https', 'net', 'child_process', 'os'];
    if (nodeBuiltins.includes(spec)) {
      blockers.push(`App entry imports Node module "${spec}" — not available in the browser preview.`);
      continue;
    }

    const root = spec.split('/')[0] ?? spec;
    const allowed =
      ALLOWED_BARE_IMPORTS.has(spec) ||
      ALLOWED_BARE_IMPORTS.has(root) ||
      spec.startsWith('firebase/');
    if (!allowed) {
      warnings.push(
        `App entry imports "${spec}" — must be installed via the Packages tab (esm.sh) or use react/firebase/* / relative paths.`,
      );
    }
  }

  return { blockers, warnings };
}

function computeTier(
  blockers: string[],
  warnings: string[],
  layout: WorkspaceLayoutKind,
  hasRules: boolean,
  hasApp: boolean,
): WorkspaceProbeTier {
  if (blockers.length > 0 || !hasRules || !hasApp) return 'red';
  if (
    layout === 'playground-native' &&
    warnings.length === 0
  ) {
    return 'green';
  }
  if (layout === 'pyric-init-web') {
    return 'red'; // public/app.js — no TSX preview path yet
  }
  return 'yellow';
}

/**
 * Probe file paths + contents for playground compatibility.
 * Pure over inputs — use {@link probeWorkspace} for live VFS.
 */
export async function probeWorkspaceFiles(
  allFiles: string[],
  input: Pick<WorkspaceProbeInput, 'readFile'> & { root?: string },
): Promise<WorkspaceProbeResult> {
  const workspaceRoot = input.root ?? WORKSPACE_ROOT;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const contentRoot = detectContentRoot(allFiles, workspaceRoot);
  if (contentRoot !== workspaceRoot) {
    warnings.push(
      `Project files live under ${contentRoot} — materialize will flatten into ${workspaceRoot}.`,
    );
  }

  const rulesPath = discoverRulesPath(allFiles, contentRoot);
  const appHit = discoverAppEntry(allFiles, contentRoot);
  const appPath = appHit?.path ?? null;
  const layout = classifyLayout(contentRoot, appHit?.kind ?? null, rulesPath, appPath);

  if (!rulesPath) {
    blockers.push(
      `No firestore.rules found under ${contentRoot} — playground requires Firestore rules at ${RULES_PATH} after import.`,
    );
  }

  if (!appPath) {
    blockers.push(
      `No supported app entry found — expected src/App.tsx (or src/App.jsx / src/generated/app-source.tsx) under ${contentRoot}.`,
    );
  } else if (layout === 'pyric-init-web') {
    blockers.push(
      'Repo uses pyric init web (public/app.js) — playground preview requires a React TSX entry; import not supported yet.',
    );
  }

  const pkgPath = joinPath(contentRoot, 'package.json');
  if (allFiles.includes(pkgPath)) {
    const pkgText = await input.readFile(pkgPath);
    if (pkgText) {
      const pkg = analyzePackageJson(pkgText);
      blockers.push(...pkg.blockers);
      warnings.push(...pkg.warnings);
    }
  }

  if (appPath) {
    const entryText = await input.readFile(appPath);
    if (entryText) {
      const scan = scanEntryImports(entryText);
      blockers.push(...scan.blockers);
      warnings.push(...scan.warnings);
      if (!/\bexport\s+default\b/.test(entryText)) {
        warnings.push('App entry has no `export default` — preview expects a default-exported React component.');
      }
    } else {
      warnings.push(`Could not read app entry at ${appPath}.`);
    }
  }

  const testPaths = discoverTestPaths(allFiles, contentRoot);

  const tier = computeTier(blockers, warnings, layout, !!rulesPath, !!appPath);

  const mappings: WorkspaceFileMappings | null =
    rulesPath && appPath
      ? {
          contentRoot,
          rulesPath,
          appEntryPath: appPath,
          canonical: {
            rulesPath: RULES_PATH,
            appEntryPath: APP_ENTRY_PATH,
          },
          testPaths,
        }
      : null;

  return { tier, layout, blockers, warnings, mappings };
}

/** Probe the live session VFS under {@link WORKSPACE_ROOT}. */
export async function probeWorkspace(
  input: Partial<WorkspaceProbeInput> = {},
): Promise<WorkspaceProbeResult> {
  const root = input.root ?? WORKSPACE_ROOT;
  const listFiles = input.listFiles ?? listAllFiles;
  const readFile =
    input.readFile ??
    (async (path: string) => {
      try {
        const raw = await getVFS().promises.readFile(path, 'utf8');
        return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
      } catch {
        return null;
      }
    });

  const allFiles = await listFiles(root);
  return probeWorkspaceFiles(allFiles, { root, readFile });
}
