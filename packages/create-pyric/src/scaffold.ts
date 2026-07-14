/**
 * Shared project scaffold used by `create-pyric` and `pyric init`.
 *
 * Never prompts. Idempotent: existing files are merged (package.json) or
 * skipped; `--force` overwrites scaffold-owned files only.
 */

import { writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { TEMPLATES, type ScaffoldTemplate } from './templates.js';
import type { FlagValue } from './parse-args.js';

export type { ScaffoldTemplate };
export { TEMPLATES };

/** Where the scaffold's `pyric` / `@pyric/cli` deps come from. */
export type DepsMode = 'vendor' | 'npm';

/** Return a copy of `t` with `pyric` / `@pyric/cli` deps rewritten for `mode`. */
export function applyDepsMode(
  t: ScaffoldTemplate,
  mode: DepsMode,
  opts: { vendorSpecs?: Record<string, string>; version?: string | null },
): ScaffoldTemplate {
  const WORKSPACE_PKGS = ['pyric', '@pyric/cli'];
  const rewrite = (section: Record<string, string>): Record<string, string> => {
    const next = { ...section };
    for (const pkg of WORKSPACE_PKGS) {
      if (!(pkg in next)) continue;
      next[pkg] =
        mode === 'vendor'
          ? (opts.vendorSpecs?.[pkg] ?? next[pkg])
          : opts.version
            ? `^${opts.version}`
            : next[pkg];
    }
    if (mode === 'vendor' && '@pyric/cli' in next && !('pyric' in next) && opts.vendorSpecs?.pyric) {
      next.pyric = opts.vendorSpecs.pyric;
    }
    return next;
  };
  const overrides =
    mode === 'vendor' && opts.vendorSpecs?.pyric ? { pyric: opts.vendorSpecs.pyric } : t.overrides;
  return {
    ...t,
    dependencies: rewrite(t.dependencies),
    devDependencies: rewrite(t.devDependencies),
    overrides,
  };
}

export interface PackageJsonMerge {
  contents: string;
  added: string[];
  conflicts: Array<{ key: string; existing: unknown; wanted: unknown }>;
  unchanged: boolean;
}

function detectIndent(raw: string): string | number {
  const m = raw.match(/\n([ \t]+)"/);
  if (!m) return 2;
  const ws = m[1]!;
  return ws.includes('\t') ? '\t' : ws.length;
}

/** Merge template fields into an existing package.json. Never overwrites. */
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

export function packageJsonFor(name: string, t: ScaffoldTemplate): string {
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

/** Stable `--json` contract; agents parse this. */
export interface ScaffoldResult {
  template: 'web' | 'node' | 'static';
  dir: string;
  depsMode: DepsMode;
  created: string[];
  merged: string[];
  skipped: string[];
  conflicts: Array<{ key: string; existing: unknown; wanted: unknown }>;
  nextSteps: string[];
}

export interface ScaffoldIo {
  writeFile?: typeof writeFile;
  readFile?: typeof readFile;
  mkdir?: typeof mkdir;
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

export interface ScaffoldRequest {
  /** Absolute or relative project directory (relative resolved against cwd). */
  dir?: string;
  template?: 'web' | 'node' | 'static';
  name?: string;
  force?: boolean;
  json?: boolean;
  depsMode?: DepsMode;
  /** Already-rewritten template; defaults to TEMPLATES[template] (+ npm pin). */
  effectiveTemplate?: ScaffoldTemplate;
  /** Version pin for npm-mode `@pyric/cli` / `pyric` ranges. */
  pinVersion?: string | null;
  /** Label used in human report lines (`create-pyric` or `pyric init`). */
  commandLabel?: string;
  /** Extra paths already created (e.g. vendor tarballs) to list in the report. */
  preCreated?: string[];
}

/** Reclaim `--force dir` / `--json dir` when a parser bound the value as the flag. */
export function normalizeBoolFlags(flags: Map<string, FlagValue>, positional: string[]): void {
  for (const key of ['force', 'json']) {
    const v = flags.get(key);
    if (typeof v === 'string') {
      positional.push(v);
      flags.set(key, true);
    }
  }
}

/**
 * Write the scaffold into `dir`. Caller prepares vendor tarballs / pin when
 * needed and may pass `effectiveTemplate`.
 */
export async function runScaffold(
  request: ScaffoldRequest,
  deps: ScaffoldIo = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const cwd = deps.cwd ?? process.cwd();
  const write = deps.writeFile ?? writeFile;
  const read = deps.readFile ?? readFile;
  const mk = deps.mkdir ?? mkdir;
  const exists = deps.exists ?? defaultExists;
  const label = request.commandLabel ?? 'create-pyric';

  const templateName = request.template ?? 'web';
  if (templateName !== 'web' && templateName !== 'node' && templateName !== 'static') {
    err.write(`${label}: unknown template '${templateName}' (expected web|node|static)\n`);
    return 1;
  }
  const template = TEMPLATES[templateName];
  const depsMode: DepsMode = request.depsMode ?? 'npm';
  const pinVersion = request.pinVersion ?? null;

  const dir = request.dir ? resolve(cwd, request.dir) : cwd;
  const projectName =
    request.name && request.name.length > 0 ? request.name : basename(dir);
  const force = request.force === true;
  const json = request.json === true;
  const report = json ? err : out;

  try {
    for (const d of [dir, ...template.dirs.map((d) => join(dir, d))]) {
      await mk(d, { recursive: true });
    }
  } catch (e) {
    err.write(
      `${label}: failed to create project directories: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

  const effective =
    request.effectiveTemplate ??
    applyDepsMode(template, depsMode === 'vendor' ? 'vendor' : 'npm', {
      version: pinVersion,
    });

  const result: ScaffoldResult = {
    template: templateName,
    dir,
    depsMode,
    created: [...(request.preCreated ?? [])],
    merged: [],
    skipped: [],
    conflicts: [],
    nextSteps: template.nextSteps,
  };

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
      `${label}: failed to handle package.json: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 2;
  }

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
        `${label}: failed to write ${t.name}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  }

  report.write(`${label}: scaffolded ${templateName} project "${projectName}" in ${dir}\n`);
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
      ? '\n  deps: vendored pyric + @pyric/cli into vendor/ — installs offline, no registry\n'
      : `\n  deps: pyric + @pyric/cli from npm${pinVersion ? ` (^${pinVersion})` : ''}\n`,
  );

  report.write('\nNext steps:\n');
  for (const s of result.nextSteps) report.write(`  ${s}\n`);

  if (json) out.write(JSON.stringify(result) + '\n');
  return 0;
}
