/**
 * `pyric init` — scaffold a pyric project (v2, agent-first).
 *
 *   pyric init [dir] [--name N] [--template web|node|static] [--force] [--json]
 *              [--deps vendor|npm] [--pyric-version X]
 *
 * Scaffold templates and file writing live in `create-pyric`. This module
 * adds standalone-binary vendor mode (`--deps vendor`) and `pyric vendor`.
 */

import { writeFile, readFile, mkdir, access } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import type { ParsedArgs } from './parse-args.js';
import {
  TEMPLATES,
  applyDepsMode,
  mergeIntoExistingPackageJson,
  packageJsonFor,
  normalizeBoolFlags as normalizeScaffoldBoolFlags,
  runScaffold,
  type ScaffoldTemplate,
  type DepsMode,
  type PackageJsonMerge,
} from 'create-pyric';
import {
  isStandalone,
  hasEmbeddedTarballs,
  embeddedVersion,
  materializeVendorTarballs,
} from '../serve/standalone-assets.js';

export type { DepsMode, ScaffoldTemplate };
export { TEMPLATES, applyDepsMode, mergeIntoExistingPackageJson };

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

export interface InitResult {
  template: 'web' | 'node' | 'static';
  dir: string;
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

function normalizeBoolFlags(parsed: ParsedArgs): void {
  normalizeScaffoldBoolFlags(parsed.flags, parsed.positional);
}

export async function runInit(parsed: ParsedArgs, deps: InitDeps = {}): Promise<number> {
  const err = deps.stderr ?? process.stderr;

  normalizeBoolFlags(parsed);

  const templateFlag = parsed.flags.get('template');
  const templateName = typeof templateFlag === 'string' ? templateFlag : 'web';
  if (templateName !== 'web' && templateName !== 'node' && templateName !== 'static') {
    err.write(`pyric init: unknown template '${templateName}' (expected web|node|static)\n`);
    return 1;
  }

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

  const versionFlag = parsed.flags.get('pyric-version');
  const pinVersion =
    typeof versionFlag === 'string' && versionFlag.length > 0
      ? versionFlag
      : isStandalone()
        ? embeddedVersion()
        : null;

  const cwd = deps.cwd ?? process.cwd();
  const dir = parsed.positional[0] ? resolve(cwd, parsed.positional[0]) : cwd;
  const nameFlag = parsed.flags.get('name');
  const projectName =
    typeof nameFlag === 'string' && nameFlag.length > 0 ? nameFlag : basename(dir);

  const template = TEMPLATES[templateName];
  let effective = template;
  const preCreated: string[] = [];

  if (depsMode === 'vendor') {
    try {
      const vendorSpecs = await materializeVendorTarballs(dir);
      for (const spec of Object.values(vendorSpecs)) preCreated.push(spec.replace(/^file:/, ''));
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

  return runScaffold(
    {
      dir,
      template: templateName,
      name: projectName,
      force: parsed.flags.get('force') === true,
      json: parsed.flags.get('json') === true,
      depsMode,
      effectiveTemplate: effective,
      pinVersion,
      commandLabel: 'pyric init',
      preCreated,
    },
    deps,
  );
}

export const VENDOR_TEMPLATE: ScaffoldTemplate = {
  scripts: {},
  dependencies: {},
  devDependencies: { '@pyric/cli': '*' },
  dirs: [],
  files: () => [],
  nextSteps: [],
};

/**
 * `pyric vendor [dir]` — lay vendored tarballs into an existing project.
 * Standalone-binary only.
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
        '@pyric/cli tarballs). A monorepo/npm checkout has nothing to vendor; depend ' +
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

  report.write(
    `pyric vendor: vendored ${Object.keys(vendorSpecs).join(', ')} into ${join(dir, 'vendor')}\n`,
  );
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
