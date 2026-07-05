/**
 * `pyric init` — scaffold a pyric project (v2, agent-first).
 *
 *   pyric init [dir] [--name N] [--template web|node|static] [--force] [--json]
 *              [--deps vendor|npm] [--pyric-version X]
 *
 * `--deps` picks where `pyric` / `pyric-tools` resolve from. The standalone
 * binary defaults to `vendor`: it lays packed tarballs into `vendor/` and points
 * the deps at them (`file:vendor/*.tgz`), so `bun install` works with the
 * packages still unpublished. `--deps npm` writes registry ranges instead (pinned
 * to the binary's version, or `--pyric-version`) for once they're published.
 *
 * Templates live in `./init-templates.js`. `web` (default) scaffolds a Vite app
 * on the `pyric-tools/vite` plugin: `vite dev` runs canonical `firebase/*`
 * imports against the in-process sandbox, `vite build` ships the real `firebase`
 * package — one toolchain, the swap is environmental (dev vs build), never a
 * code edit. `static` is the serve-era no-bundler scaffold (`pyric serve`).
 *
 * Agent-first contract (the design rationale §CLI UX):
 *   - NEVER prompts — every choice is a flag with a default.
 *   - Idempotent: existing files are merged (package.json) or skipped;
 *     rerunning is safe. `--force` overwrites scaffold-owned files only.
 *   - `--json`: one machine-readable line on stdout
 *     `{template, dir, created, merged, skipped, conflicts, nextSteps}`;
 *     the human report moves to stderr.
 *   - Exit codes: 0 ok, 1 usage, 2 runtime.
 */

import { writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import type { ParsedArgs } from './parse-args.js';
import { TEMPLATES, type ScaffoldTemplate } from './init-templates.js';
import {
  isStandalone,
  hasEmbeddedTarballs,
  embeddedVersion,
  materializeVendorTarballs,
} from '../serve/standalone-assets.js';

/** Where the scaffold's `pyric` / `pyric-tools` deps come from.
 *  - `vendor`: file: refs to tarballs the standalone binary lays down in
 *    `vendor/` — installs offline, no registry. Default in the binary.
 *  - `npm`: registry refs (`^<version>` or `*`) — for once the packages are
 *    published, or against a private registry. Default when not standalone. */
export type DepsMode = 'vendor' | 'npm';

/** Resolve deps mode: explicit `--deps` > `PYRIC_INIT_DEPS` env > default
 *  (vendor when the binary carries tarballs, else npm). */
export function resolveDepsMode(
  parsed: ParsedArgs,
  env: Record<string, string | undefined> = process.env,
): DepsMode {
  const flag = parsed.flags.get('deps');
  if (flag === 'vendor' || flag === 'npm') return flag;
  const fromEnv = env.PYRIC_INIT_DEPS;
  if (fromEnv === 'vendor' || fromEnv === 'npm') return fromEnv;
  return isStandalone() && hasEmbeddedTarballs() ? 'vendor' : 'npm';
}

/** Return a copy of `t` with `pyric` / `pyric-tools` deps rewritten for `mode`.
 *  Pure — caller does the tarball I/O and passes `vendorSpecs`. */
export function applyDepsMode(
  t: ScaffoldTemplate,
  mode: DepsMode,
  opts: { vendorSpecs?: Record<string, string>; version?: string | null },
): ScaffoldTemplate {
  const WORKSPACE_PKGS = ['pyric', 'pyric-tools'];
  const rewrite = (section: Record<string, string>): Record<string, string> => {
    const next = { ...section };
    for (const pkg of WORKSPACE_PKGS) {
      if (!(pkg in next)) continue;
      next[pkg] =
        mode === 'vendor'
          ? (opts.vendorSpecs?.[pkg] ?? next[pkg])
          : opts.version
            ? `^${opts.version}`
            : next[pkg]; // npm with no pin: keep the template's range (e.g. '*')
    }
    // Vendor mode: `pyric-tools` needs `pyric` co-installed (its own dep on
    // pyric is `*`, resolved from the root file: dep). The web/static templates
    // only list `pyric-tools`, so add `pyric` alongside it.
    if (mode === 'vendor' && 'pyric-tools' in next && !('pyric' in next) && opts.vendorSpecs?.pyric) {
      next.pyric = opts.vendorSpecs.pyric;
    }
    return next;
  };
  // Vendor mode pins `pyric` via overrides: a placeholder `pyric` IS published
  // to npm at a higher version than the local 0.0.0, so pyric-tools' `pyric@*`
  // would otherwise resolve to that empty stub instead of the vendored tarball.
  const overrides =
    mode === 'vendor' && opts.vendorSpecs?.pyric ? { pyric: opts.vendorSpecs.pyric } : t.overrides;
  return {
    ...t,
    dependencies: rewrite(t.dependencies),
    devDependencies: rewrite(t.devDependencies),
    overrides,
  };
}

/**
 * Result of merging the required scaffolding into an existing
 * package.json. Drives the user-facing report so they can see exactly
 * what was added and what was kept.
 */
interface PackageJsonMerge {
  /** New file contents to write. */
  contents: string;
  /** Keys added by this run (e.g. ["scripts.start", "dependencies.pyric"]). */
  added: string[];
  /**
   * Keys that already existed with a value that differs from what we
   * would have written. NOT overwritten — surfaced so the user can
   * reconcile manually.
   */
  conflicts: Array<{ key: string; existing: unknown; wanted: unknown }>;
  /** True when no keys changed (everything was already present). */
  unchanged: boolean;
}

function detectIndent(raw: string): string | number {
  // Cheap heuristic: scan for the indent of the first nested key.
  const m = raw.match(/\n([ \t]+)"/);
  if (!m) return 2;
  const ws = m[1]!;
  return ws.includes('\t') ? '\t' : ws.length;
}

/**
 * Merge the template's required fields into an already-existing
 * package.json. Never overwrites; only fills in what's missing.
 * Existing-but-different values are recorded as conflicts.
 *
 * Pure function — caller does the I/O. Easy to unit-test.
 */
export function mergeIntoExistingPackageJson(
  raw: string,
  projectName: string,
  template: ScaffoldTemplate,
): PackageJsonMerge {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `package.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const indent = detectIndent(raw);
  const added: string[] = [];
  const conflicts: PackageJsonMerge['conflicts'] = [];

  // Top-level scalars: add when missing, never overwrite.
  if (parsed.name === undefined) {
    parsed.name = projectName;
    added.push('name');
  }
  if (parsed.type === undefined) {
    parsed.type = 'module';
    added.push('type');
  } else if (parsed.type !== 'module') {
    conflicts.push({ key: 'type', existing: parsed.type, wanted: 'module' });
  }
  if (parsed.private === undefined) {
    parsed.private = true;
    added.push('private');
  }

  const mergeObject = (
    field: 'scripts' | 'dependencies' | 'devDependencies' | 'overrides',
    wanted: Record<string, string>,
  ) => {
    if (parsed[field] === undefined) {
      parsed[field] = {};
    }
    const obj = parsed[field] as Record<string, unknown>;
    for (const [key, value] of Object.entries(wanted)) {
      if (obj[key] === undefined) {
        obj[key] = value;
        added.push(`${field}.${key}`);
      } else if (obj[key] !== value) {
        conflicts.push({ key: `${field}.${key}`, existing: obj[key], wanted: value });
      }
    }
  };
  mergeObject('scripts', template.scripts);
  mergeObject('dependencies', template.dependencies);
  mergeObject('devDependencies', template.devDependencies);
  if (template.overrides) mergeObject('overrides', template.overrides);

  return {
    contents: JSON.stringify(parsed, null, indent) + '\n',
    added,
    conflicts,
    unchanged: added.length === 0 && conflicts.length === 0,
  };
}

function packageJsonFor(name: string, t: ScaffoldTemplate): string {
  return (
    JSON.stringify(
      {
        name,
        version: '0.0.0',
        type: 'module',
        private: true,
        scripts: t.scripts,
        dependencies: t.dependencies,
        devDependencies: t.devDependencies,
        ...(t.overrides ? { overrides: t.overrides } : {}),
      },
      null,
      2,
    ) + '\n'
  );
}

/** The `--json` contract — keep stable; agents parse this. */
export interface InitResult {
  template: 'web' | 'node' | 'static';
  dir: string;
  /** Where pyric/pyric-tools deps resolve from: vendored tarballs or npm. */
  depsMode: DepsMode;
  created: string[];
  merged: string[];
  skipped: string[];
  conflicts: Array<{ key: string; existing: unknown; wanted: unknown }>;
  nextSteps: string[];
}

export interface InitDeps {
  writeFile?: typeof writeFile;
  readFile?: typeof readFile;
  mkdir?: typeof mkdir;
  /** Returns true when a file/dir already exists at `path`. */
  exists?: (path: string) => Promise<boolean>;
  cwd?: string;
  stdout?: { write(s: string): void };
  stderr?: { write(s: string): void };
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The parser binds `--force dir` as flag=dir; reclaim the value as the
 *  positional it was and keep the flag boolean. */
function normalizeBoolFlags(parsed: ParsedArgs): void {
  for (const key of ['force', 'json']) {
    const v = parsed.flags.get(key);
    if (typeof v === 'string') {
      parsed.positional.push(v);
      parsed.flags.set(key, true);
    }
  }
}

export async function runInit(parsed: ParsedArgs, deps: InitDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const write = deps.writeFile ?? writeFile;
  const read = deps.readFile ?? readFile;
  const mk = deps.mkdir ?? mkdir;
  const exists = deps.exists ?? defaultExists;

  normalizeBoolFlags(parsed);
  const json = parsed.flags.get('json') === true;
  const force = parsed.flags.get('force') === true;
  const report = json ? err : out; // human report; stdout stays machine-clean under --json

  const templateFlag = parsed.flags.get('template');
  const templateName = typeof templateFlag === 'string' ? templateFlag : 'web';
  if (templateName !== 'web' && templateName !== 'node' && templateName !== 'static') {
    err.write(`pyric init: unknown template '${templateName}' (expected web|node|static)\n`);
    return 1;
  }
  const template = TEMPLATES[templateName];

  const depsFlag = parsed.flags.get('deps');
  if (depsFlag !== undefined && depsFlag !== 'vendor' && depsFlag !== 'npm') {
    err.write(`pyric init: --deps must be 'vendor' or 'npm' (got '${String(depsFlag)}')\n`);
    return 1;
  }
  const depsMode = resolveDepsMode(parsed);
  if (depsMode === 'vendor' && !(isStandalone() && hasEmbeddedTarballs())) {
    err.write(
      `pyric init: --deps vendor needs the standalone binary (with embedded packages). Use --deps npm.\n`,
    );
    return 1;
  }
  // npm-mode version pin: explicit flag > the binary's baked version > the
  // template's own range (kept when neither is available, e.g. from the monorepo).
  const versionFlag = parsed.flags.get('pyric-version');
  const pinVersion =
    typeof versionFlag === 'string' && versionFlag.length > 0
      ? versionFlag
      : isStandalone()
        ? embeddedVersion()
        : null;

  const dir = parsed.positional[0] ? resolve(cwd, parsed.positional[0]) : cwd;
  const nameFlag = parsed.flags.get('name');
  const projectName =
    typeof nameFlag === 'string' && nameFlag.length > 0 ? nameFlag : basename(dir);

  try {
    for (const d of [dir, ...template.dirs.map((d) => join(dir, d))]) {
      await mk(d, { recursive: true });
    }
  } catch (e) {
    err.write(
      `pyric init: failed to create project directories: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  const result: InitResult = {
    template: templateName,
    dir,
    depsMode,
    created: [],
    merged: [],
    skipped: [],
    conflicts: [],
    nextSteps: template.nextSteps,
  };

  // ─── deps mode: vendor the embedded tarballs, or pin npm versions ───
  // `effective` is the template with `pyric` / `pyric-tools` deps rewritten;
  // it (not `template`) drives package.json below. Everything else — files,
  // dirs, nextSteps — is identical across modes.
  let effective = template;
  if (depsMode === 'vendor') {
    try {
      const vendorSpecs = await materializeVendorTarballs(dir);
      for (const spec of Object.values(vendorSpecs)) result.created.push(spec.replace(/^file:/, ''));
      effective = applyDepsMode(template, 'vendor', { vendorSpecs });
    } catch (e) {
      err.write(
        `pyric init: failed to vendor packages: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  } else {
    effective = applyDepsMode(template, 'npm', { version: pinVersion });
  }

  // ─── package.json: merge-into-existing or create ───────────────────
  // The only file we modify when it already exists (so the project gets
  // the scripts/deps it needs). `--force` never touches existing keys.
  const pkgPath = join(dir, 'package.json');
  let pkgMerge: PackageJsonMerge | null = null;
  try {
    if (await exists(pkgPath)) {
      const raw = (await read(pkgPath, 'utf-8')) as unknown;
      const text = typeof raw === 'string' ? raw : String(raw);
      pkgMerge = mergeIntoExistingPackageJson(text, projectName, effective);
      result.conflicts = pkgMerge.conflicts;
      if (pkgMerge.unchanged) {
        result.skipped.push('package.json');
      } else {
        await write(pkgPath, pkgMerge.contents, 'utf-8');
        result.merged.push('package.json');
      }
    } else {
      await write(pkgPath, packageJsonFor(projectName, effective), 'utf-8');
      result.created.push('package.json');
    }
  } catch (e) {
    err.write(
      `pyric init: failed to handle package.json: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  // ─── scaffold-owned files: skip-on-exist (or overwrite with --force) ──
  for (const t of template.files(projectName)) {
    const path = join(dir, t.name);
    if (!force && (await exists(path))) {
      result.skipped.push(t.name);
      continue;
    }
    try {
      await write(path, t.content, 'utf-8');
      result.created.push(t.name);
    } catch (e) {
      err.write(
        `pyric init: failed to write ${t.name}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  }

  // ─── report ───────────────────────────────────────────────────────
  report.write(
    `pyric init: scaffolded ${templateName} project "${projectName}" in ${dir}\n`,
  );
  for (const c of result.created) report.write(`  + wrote ${c}\n`);
  for (const m of result.merged) {
    report.write(`  ~ merged ${m} (added: ${pkgMerge!.added.join(', ')})\n`);
  }
  for (const s of result.skipped) report.write(`  · skipped ${s} (already exists)\n`);

  if (result.conflicts.length > 0) {
    report.write('\npackage.json — kept your values for these keys (pyric wanted different):\n');
    for (const c of result.conflicts) {
      report.write(
        `  · ${c.key}: ${JSON.stringify(c.existing)}  (pyric would have set ${JSON.stringify(c.wanted)})\n`,
      );
    }
  }

  report.write(
    depsMode === 'vendor'
      ? '\n  deps: vendored pyric + pyric-tools into vendor/ — installs offline, no registry\n'
      : `\n  deps: pyric + pyric-tools from npm${pinVersion ? ` (^${pinVersion})` : ''}\n`,
  );

  report.write('\nNext steps:\n');
  for (const s of result.nextSteps) report.write(`  ${s}\n`);

  if (json) out.write(JSON.stringify(result) + '\n');
  return 0;
}

// ─── pyric vendor: retrofit the vendored packages into any project ─────────

/**
 * The deps-only "template" for `pyric vendor`: `pyric-tools` as a devDependency.
 * `applyDepsMode(..., 'vendor', { vendorSpecs })` rewrites it to a `file:` ref and
 * adds `pyric` + the `overrides.pyric` pin alongside it. No scripts, dirs, or
 * scaffold files — vendoring touches package.json deps only.
 */
export const VENDOR_TEMPLATE: ScaffoldTemplate = {
  scripts: {},
  dependencies: {},
  devDependencies: { 'pyric-tools': '*' },
  dirs: [],
  files: () => [],
  nextSteps: [],
};

/**
 * `pyric vendor [dir]` — lay the vendored `pyric` / `pyric-tools` tarballs into an
 * existing project and merge their `file:` deps into its package.json. The
 * retrofit counterpart to `init`: it scaffolds nothing, so any Firebase app can
 * adopt the sandbox without `init --template web`. Standalone-binary only (the
 * tarballs are embedded in the binary).
 */
export async function runVendor(parsed: ParsedArgs, deps: InitDeps = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const write = deps.writeFile ?? writeFile;
  const read = deps.readFile ?? readFile;
  const mk = deps.mkdir ?? mkdir;
  const exists = deps.exists ?? defaultExists;

  normalizeBoolFlags(parsed);
  const json = parsed.flags.get('json') === true;
  const report = json ? err : out;

  if (!(isStandalone() && hasEmbeddedTarballs())) {
    err.write(
      'pyric vendor: needs the standalone binary (it carries the embedded pyric / ' +
        'pyric-tools tarballs). A monorepo/npm checkout has nothing to vendor; depend ' +
        'on the packages directly instead.\n',
    );
    return 1;
  }

  const dir = parsed.positional[0] ? resolve(cwd, parsed.positional[0]) : cwd;
  const projectName = basename(dir);

  let vendorSpecs: Record<string, string>;
  try {
    await mk(dir, { recursive: true });
    vendorSpecs = await materializeVendorTarballs(dir);
  } catch (e) {
    err.write(
      `pyric vendor: failed to lay down vendor tarballs: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  const effective = applyDepsMode(VENDOR_TEMPLATE, 'vendor', { vendorSpecs });

  const pkgPath = join(dir, 'package.json');
  let added: string[];
  let conflicts: PackageJsonMerge['conflicts'] = [];
  let created = false;
  try {
    if (await exists(pkgPath)) {
      const raw = String(await read(pkgPath, 'utf-8'));
      const merge = mergeIntoExistingPackageJson(raw, projectName, effective);
      conflicts = merge.conflicts;
      added = merge.added;
      if (!merge.unchanged) await write(pkgPath, merge.contents, 'utf-8');
    } else {
      await write(pkgPath, packageJsonFor(projectName, effective), 'utf-8');
      added = [];
      created = true;
    }
  } catch (e) {
    err.write(
      `pyric vendor: failed to update package.json: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  report.write(`pyric vendor: vendored pyric + pyric-tools into ${join(dir, 'vendor')}\n`);
  for (const spec of Object.values(vendorSpecs)) {
    report.write(`  + ${spec.replace(/^file:/, '')}\n`);
  }
  if (created) {
    report.write('  + package.json (created)\n');
  } else if (added.length === 0) {
    report.write('  · package.json already had the vendored deps\n');
  } else {
    report.write(`  ~ package.json (added: ${added.join(', ')})\n`);
  }
  for (const c of conflicts) {
    report.write(
      `  · ${c.key}: kept ${JSON.stringify(c.existing)} (pyric would set ${JSON.stringify(c.wanted)})\n`,
    );
  }
  report.write('\n  next: run `bun install` (or npm/pnpm install) to install the vendored packages.\n');

  if (json) {
    out.write(
      JSON.stringify({ dir, vendored: Object.keys(vendorSpecs), added, conflicts, created }) + '\n',
    );
  }
  return 0;
}
