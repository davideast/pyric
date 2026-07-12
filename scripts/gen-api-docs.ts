#!/usr/bin/env bun
/**
 * gen-api-docs — mechanical API-reference generation for the public
 * package subpaths.
 *
 * For each released { pkg, subpath } this runs TypeDoc (with
 * typedoc-plugin-markdown) over the tsc-emitted declaration barrel
 * `packages/<pkg>/dist/<subpath>/index.d.ts` and writes a single
 * markdown file to
 * `packages/<pkg>/docs/<subpath>/reference/api.generated.md`, stamped
 * with a "do not edit by hand" banner.
 *
 * This mirrors the `compat:generate` pattern in
 * packages/conformance/src/generate-docs.ts:
 *   --write   regenerate the committed api.generated.md files
 *   --check   regenerate into a temp dir, diff against committed, exit
 *             nonzero on drift (CI drift gate). Default when no --write.
 *
 * Released-vs-unreleased is read from each package.json's
 * `pyricUnreleasedExports` — the SAME list the pack-time stripper
 * (scripts/lib/rewrite-workspace-deps.mjs) reads. Any subpath listed
 * there is skipped; we never invent a second list.
 *
 * The generator points at dist/*.d.ts (tsc output). Build first:
 *   bash scripts/build.sh   (or: bun run build)
 *
 * IMPORTANT: this generates to api.generated.md, a NEW file. It never
 * touches the existing hand-written api.md (which carries behavioral
 * prose that is not in JSDoc). Cutover is a separate, deliberate step.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');

export const GENERATED_HEADER =
  '<!-- Generated from dist/<subpath>/index.d.ts via TypeDoc. Do not edit by hand; run bun run docs:api:generate. -->';

export interface ApiDescriptor {
  /** Workspace package directory under packages/. */
  pkg: 'pyric' | 'pyric-admin';
  /** Public subpath (no leading "./"), e.g. "firestore". */
  subpath: string;
}

/**
 * The candidate public subpaths, one per released `exports` entry we
 * publish an API reference for. Internal subpaths (rules/internal,
 * sandbox/internal, storage/internal, database/modular, messaging/sw,
 * …) are intentionally omitted — they are not consumer surface.
 *
 * Unreleased subpaths (ai, messaging, …) are NOT filtered here; they
 * are filtered dynamically against each package's
 * `pyricUnreleasedExports` in `releasedDescriptors()`.
 */
export const API_DESCRIPTORS: ApiDescriptor[] = [
  { pkg: 'pyric', subpath: 'app' },
  { pkg: 'pyric', subpath: 'firestore' },
  { pkg: 'pyric', subpath: 'auth' },
  { pkg: 'pyric', subpath: 'database' },
  { pkg: 'pyric', subpath: 'storage' },
  { pkg: 'pyric', subpath: 'rules' },
  { pkg: 'pyric', subpath: 'sandbox' },
  { pkg: 'pyric', subpath: 'firestore-values' },
  { pkg: 'pyric-admin', subpath: 'app' },
  { pkg: 'pyric-admin', subpath: 'firestore' },
  { pkg: 'pyric-admin', subpath: 'auth' },
  { pkg: 'pyric-admin', subpath: 'database' },
  { pkg: 'pyric-admin', subpath: 'storage' },
];

function unreleasedSubpaths(pkg: string): Set<string> {
  const meta = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', pkg, 'package.json'), 'utf8'));
  const list: string[] = Array.isArray(meta.pyricUnreleasedExports) ? meta.pyricUnreleasedExports : [];
  // Entries look like "./ai", "./messaging" — normalize to bare subpath.
  return new Set(list.map((s) => s.replace(/^\.\//, '')));
}

/** Descriptors minus any subpath in the package's pyricUnreleasedExports. */
export function releasedDescriptors(descriptors: ApiDescriptor[] = API_DESCRIPTORS): ApiDescriptor[] {
  const unreleasedByPkg = new Map<string, Set<string>>();
  return descriptors.filter((d) => {
    if (!unreleasedByPkg.has(d.pkg)) unreleasedByPkg.set(d.pkg, unreleasedSubpaths(d.pkg));
    return !unreleasedByPkg.get(d.pkg)!.has(d.subpath);
  });
}

export function entryDtsPath(d: ApiDescriptor): string {
  return join(REPO_ROOT, 'packages', d.pkg, 'dist', d.subpath, 'index.d.ts');
}

export function outputPath(d: ApiDescriptor): string {
  return join(REPO_ROOT, 'packages', d.pkg, 'docs', d.subpath, 'reference', 'api.generated.md');
}

/**
 * Run TypeDoc over one subpath's declaration barrel and return the
 * finished markdown (banner + body, trailing whitespace normalized).
 */
export function renderApiMarkdown(d: ApiDescriptor): string {
  const entry = entryDtsPath(d);
  if (!existsSync(entry)) {
    throw new Error(
      `missing declaration entry: ${entry}\n  Build first: bash scripts/build.sh (or bun run build)`,
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), 'pyric-apidocs-'));
  try {
    const options = {
      entryPoints: [entry],
      plugin: ['typedoc-plugin-markdown'],
      out: tmp,
      name: `${d.pkg}/${d.subpath}`,
      readme: 'none',
      githubPages: false,
      skipErrorChecking: true,
      excludeInternal: true,
      excludePrivate: true,
      disableSources: true,
      outputFileStrategy: 'modules',
      hideBreadcrumbs: true,
      hidePageHeader: true,
    };
    const optionsPath = join(tmp, 'typedoc.json');
    writeFileSync(optionsPath, JSON.stringify(options, null, 2));
    execFileSync('bunx', ['typedoc', '--options', optionsPath], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    // outputFileStrategy=modules with a single entry point emits one file.
    const body = readFileSync(join(tmp, 'README.md'), 'utf8').replace(/\s+$/, '');
    return `${GENERATED_HEADER}\n\n${body}\n`;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): { write: boolean; check: boolean; only: Set<string> | null } {
  const write = argv.includes('--write');
  const check = argv.includes('--check') || !write;
  const only: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) only.push(next);
    }
  }
  return { write, check, only: only.length ? new Set(only) : null };
}

function selected(only: Set<string> | null): ApiDescriptor[] {
  const released = releasedDescriptors();
  if (!only) return released;
  return released.filter((d) => only.has(`${d.pkg}/${d.subpath}`));
}

if (import.meta.main) {
  const { write, check, only } = parseArgs(process.argv.slice(2));
  const descriptors = selected(only);
  if (descriptors.length === 0) {
    console.error('No matching released descriptors (check --only spelling: <pkg>/<subpath>).');
    process.exit(1);
  }

  if (write) {
    for (const d of descriptors) {
      const markdown = renderApiMarkdown(d);
      const out = outputPath(d);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, markdown);
      console.log(`Generated ${out.replace(REPO_ROOT + '/', '')}`);
    }
    console.log(`Generated ${descriptors.length} API reference document(s).`);
  }

  if (check) {
    const problems: string[] = [];
    for (const d of descriptors) {
      const out = outputPath(d);
      const generated = renderApiMarkdown(d);
      const rel = out.replace(REPO_ROOT + '/', '');
      if (!existsSync(out)) {
        problems.push(`${rel}: missing (run bun run docs:api:generate)`);
        continue;
      }
      if (readFileSync(out, 'utf8') !== generated) {
        problems.push(`${rel}: does not match TypeDoc-generated output`);
      }
    }
    if (problems.length > 0) {
      for (const p of problems) console.error(`- ${p}`);
      process.exit(1);
    }
    console.log(`API reference markdown is generated from dist declarations (${descriptors.length} checked).`);
  }
}
