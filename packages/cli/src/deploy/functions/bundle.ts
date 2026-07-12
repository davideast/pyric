/**
 * Node-only source bundler. Walks `localDir`, reads `package.json`,
 * zips eligible files into a `Uint8Array` Cloud Build can consume.
 *
 * Imports `node:*` and `fflate` — wired only from the Node adapter
 * (`deployHandler.ts`), never from `core.ts`.
 *
 * Default ignore set keeps the bundle small without a `.gcloudignore`:
 *   node_modules/, dist/, lib/, build/, out/, coverage/,
 *   .git/, .DS_Store, *.log, hidden files at any depth.
 *
 * Cloud Build's nodejs buildpack handles either pre-compiled JS or a
 * `"build": "tsc"` script, so we don't run `tsc` here.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';
import { zipSync, type Zippable } from 'fflate';

export interface BundleResult {
  zip: Uint8Array;
  /** Files included in the zip (relative POSIX paths). */
  files: string[];
  /**
   * Inferred runtime from `package.json`'s `engines.node`. Caller
   * uses this when no per-function `runtime` override is set.
   * Format: `nodejs<major>` (e.g. `nodejs22`). Falls back to
   * `nodejs22` when `engines.node` is missing or unparseable.
   */
  runtime: string;
}

export interface BundleOptions {
  /**
   * When true (default), the bundled `package.json` is rewritten to
   * remove fields the Cloud Build buildpack should not touch:
   *   - `devDependencies` — buildpack's `npm ci` errors on any
   *      dev dep missing from the lockfile, and devDeps that are
   *      unpublished workspace packages 404 entirely.
   *   - `scripts.build` / `build:watch` / `prebuild` / `postbuild`
   *      — the buildpack runs these by default; we ship pre-compiled
   *      JS in `lib/` instead.
   *
   * The lockfile (`package-lock.json` / `npm-shrinkwrap.json`) is also
   * dropped when slimming — once devDeps are stripped, any pinned
   * lockfile is stale and `npm ci` fails the build. The buildpack
   * falls back to `npm install --omit=dev` against the slim
   * package.json, which resolves runtime deps correctly.
   *
   * Set `slim: false` to ship the package.json verbatim — useful when
   * the function genuinely needs `npm run build` to run on the build
   * server (e.g. native Node addons that compile per architecture).
   */
  slim?: boolean;
}

/**
 * Directories the bundler skips by default. `lib/` is intentionally
 * NOT in this list — for Cloud Functions Gen 2 the typical pattern
 * is to ship pre-compiled JS in `lib/` (matching `package.json`'s
 * `main`) and skip the buildpack's `npm run build` step. Callers
 * who prefer to ship TS source and let Cloud Build compile can
 * keep `lib/` out via a future `.gcloudignore` (not yet honored).
 */
const DEFAULT_IGNORE = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git',
]);

const DEFAULT_IGNORE_FILES = new Set([
  '.DS_Store',
]);

export function bundleFunctionSource(
  localDir: string,
  options: BundleOptions = {},
): BundleResult {
  const slim = options.slim !== false;

  // Validate package.json — required for the buildpack.
  let pkg: PackageJson;
  try {
    const raw = readFileSync(join(localDir, 'package.json'), 'utf8');
    pkg = JSON.parse(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not read ${localDir}/package.json: ${message}`);
  }

  const collected: { path: string; bytes: Uint8Array }[] = [];
  walk(localDir, localDir, collected, slim);
  if (collected.length === 0) {
    throw new Error(`Source directory "${localDir}" contains no files (after applying default ignores)`);
  }

  // Slim the bundled package.json before zipping. Original on disk
  // is untouched; only the in-zip copy is rewritten.
  if (slim) {
    const slimPkgBytes = new TextEncoder().encode(JSON.stringify(slimPackageJson(pkg), null, 2));
    let replaced = false;
    for (const f of collected) {
      if (f.path === 'package.json') {
        f.bytes = slimPkgBytes;
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      // package.json wasn't in the walk (extremely unusual — every
      // function package has one). Add the slim version so the
      // buildpack has something to read.
      collected.push({ path: 'package.json', bytes: slimPkgBytes });
    }
  }

  // Build the fflate Zippable tree from flat path entries.
  const tree: Zippable = {};
  for (const f of collected) {
    insertIntoTree(tree, f.path.split('/'), f.bytes);
  }
  const zip = zipSync(tree);

  return {
    zip,
    files: collected.map((f) => f.path).sort(),
    runtime: deriveRuntime(pkg.engines?.node),
  };
}

interface PackageJson {
  name?: string;
  version?: string;
  type?: string;
  main?: string;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Strip dev-only and build-trigger fields from package.json so the
 * Cloud Build buildpack runs a minimal `npm install` and skips
 * compile. Keeps the runtime contract (`name`, `main`, `engines`,
 * `type`, `dependencies`) verbatim.
 */
function slimPackageJson(pkg: PackageJson): Record<string, unknown> {
  const slim: Record<string, unknown> = { ...pkg };
  delete slim.devDependencies;
  if (pkg.scripts) {
    const scripts: Record<string, string> = { ...pkg.scripts };
    delete scripts.build;
    delete scripts['build:watch'];
    delete scripts.prebuild;
    delete scripts.postbuild;
    if (Object.keys(scripts).length > 0) slim.scripts = scripts;
    else delete slim.scripts;
  }
  return slim;
}

function walk(
  root: string,
  dir: string,
  out: { path: string; bytes: Uint8Array }[],
  slim: boolean,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gcloudignore') continue;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (DEFAULT_IGNORE.has(entry.name)) continue;
      walk(root, join(dir, entry.name), out, slim);
      continue;
    }
    if (DEFAULT_IGNORE_FILES.has(entry.name)) continue;
    if (entry.name.endsWith('.log') || entry.name.endsWith('.tsbuildinfo')) continue;
    // Lockfiles only matter for `npm ci`, which the buildpack runs
    // when one is present. With a slimmed package.json the lockfile
    // is stale by definition (devDeps stripped), so drop it and let
    // the buildpack fall back to `npm install --omit=dev`.
    if (slim && (entry.name === 'package-lock.json' || entry.name === 'npm-shrinkwrap.json')) continue;

    const full = join(dir, entry.name);
    if (!entry.isFile()) {
      try { if (!statSync(full).isFile()) continue; } catch { continue; }
    }
    const rel = relative(root, full);
    const posixRel = sep === posix.sep ? rel : rel.split(sep).join(posix.sep);
    out.push({
      path: posixRel,
      bytes: new Uint8Array(readFileSync(full)),
    });
  }
}

function insertIntoTree(tree: Zippable, segments: string[], bytes: Uint8Array): void {
  // Last segment is the file; everything before it is a directory chain.
  const file = segments[segments.length - 1];
  let cursor: Zippable = tree;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const next = cursor[seg];
    if (!next || next instanceof Uint8Array || Array.isArray(next)) {
      // A naming collision (file vs directory at same path) shouldn't
      // happen with a real filesystem, but guard against it.
      const child: Zippable = {};
      cursor[seg] = child;
      cursor = child;
    } else {
      cursor = next as Zippable;
    }
  }
  cursor[file] = bytes;
}

/**
 * Map `engines.node` (semver range) to a Cloud Functions runtime
 * string. We only need the major version; everything else is ignored.
 * Cloud Functions Gen 2 currently supports nodejs18, nodejs20, nodejs22.
 * Anything outside that set falls back to nodejs22 (the most current
 * default). Worst case the deploy fails and the caller learns to set
 * `engines.node` properly.
 */
function deriveRuntime(engines: string | undefined): string {
  if (!engines) return 'nodejs22';
  const match = engines.match(/(\d+)/);
  if (!match) return 'nodejs22';
  const major = parseInt(match[1], 10);
  if (major === 18 || major === 20 || major === 22) return `nodejs${major}`;
  return 'nodejs22';
}
