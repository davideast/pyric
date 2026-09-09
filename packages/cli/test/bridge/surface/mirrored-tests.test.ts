/**
 * Section 3's mirror rule, enforced: every source module under the tool
 * surface has a same-named `.test.ts` at the same path under `test/`.
 *
 * Three kinds of file are exempt rather than gapped:
 *
 * - a generated file (`*.generated.ts`), never hand-edited;
 * - a per-record data file, `methods/<tool>/<method>.ts` or
 *   `tools/<tool>.ts`, one record per file under the data-record convention,
 *   which the record's own loader test (`methods/registry.test.ts`,
 *   `rules-engines/registry.test.ts`) already exercises by loading every
 *   file in the directory;
 * - a type-only module, which has no runtime behaviour to pin.
 *
 * Everything else needs a mirror. `KNOWN_GAPS` is the accepted, pre-existing
 * debt this test does not re-open: files the review that added this test
 * found already missing a mirror, outside the change that added the test.
 * The list is closed both ways, so it cannot silently grow (a new gap fails
 * the same as before) and it cannot silently go stale (fixing one of these
 * files without trimming the list fails too, which is what keeps the list
 * honest as debt is paid down).
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const PACKAGE_ROOT = resolve(import.meta.dir, '../../..');
const SRC = join(PACKAGE_ROOT, 'src');
const TEST = join(PACKAGE_ROOT, 'test');

/** Type-only modules: nothing but interfaces and type aliases, so no test file pins them. */
const TYPE_ONLY = new Set([
  'bridge/surface/method-types.ts',
  'bridge/surface/rules-engines/types.ts',
]);

/**
 * Pre-existing gaps this test does not re-open. Each is a source file, still
 * missing its mirror, that predates the change that added this test.
 */
const KNOWN_GAPS = new Set([
  'bridge/surface/context.ts',
  'bridge/surface/identity.ts',
  'bridge/surface/index.ts',
  'bridge/surface/json-schema.ts',
  'bridge/surface/render/discriminator.ts',
  'bridge/surface/render/discriminator-resources.ts',
  'bridge/surface/render/discriminator-routes.ts',
  'bridge/surface/render/discriminator-schemas.ts',
  'bridge/surface/render/noun-prefixed.ts',
  'bridge/surface/render/sdk-service.ts',
  'bridge/surface/render/verb-prefixed.ts',
  'bridge/surface/render/verb-suffixed.ts',
  'bridge/surface/rules-simulation.ts',
  'bridge/surface/seed-apply.ts',
  'bridge/surface/service-handles.ts',
  'bridge/surface/storage-rules.ts',
  'bridge/surface/types.ts',
]);

/** Every `.ts` source file under one directory, recursively, relative to `src/`. */
function tsFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...tsFilesUnder(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      files.push(relative(SRC, full));
    }
  }
  return files;
}

/** A per-record data file: `methods/<tool>/<method>.ts` or `tools/<tool>.ts`. */
function isDataRecord(relPath: string): boolean {
  const parts = relPath.split('/');
  const parent = parts.at(-2);
  const grandparent = parts.at(-3);
  if (grandparent === 'methods') return true;
  if (parent === 'tools') return true;
  return false;
}

/** The scope this rule covers: the whole surface tree, plus the CLI's per-record surface runner. */
function scopedSourceFiles(): string[] {
  const surface = tsFilesUnder(join(SRC, 'bridge/surface'));
  const cliDir = join(SRC, 'cli');
  const cliFiles = readdirSync(cliDir)
    .filter((name) => name.startsWith('surface-method-') && name.endsWith('.ts'))
    .map((name) => relative(SRC, join(cliDir, name)));
  return [...surface, ...cliFiles];
}

/** Whether `<relPath>` has a `.test.ts` mirror at the same path under `test/`. */
function hasMirror(relPath: string): boolean {
  const mirror = join(TEST, relPath.replace(/\.ts$/, '.test.ts'));
  try {
    return statSync(mirror).isFile();
  } catch {
    return false;
  }
}

describe('every surface source module has a mirrored test file', () => {
  const sourceFiles = scopedSourceFiles();

  it('names at least the modules this rule is known to cover', () => {
    expect(sourceFiles).toContain('bridge/surface/method-call.ts');
    expect(sourceFiles).toContain('cli/surface-method-runner.ts');
  });

  it('has no gap beyond the accepted, pre-existing list', () => {
    const unexpected = sourceFiles.filter(
      (relPath) =>
        !relPath.endsWith('.generated.ts') &&
        !isDataRecord(relPath) &&
        !TYPE_ONLY.has(relPath) &&
        !KNOWN_GAPS.has(relPath) &&
        !hasMirror(relPath),
    );
    expect(unexpected).toEqual([]);
  });

  it('keeps KNOWN_GAPS trimmed to gaps that are still real', () => {
    const stale = [...KNOWN_GAPS].filter((relPath) => hasMirror(relPath));
    expect(stale).toEqual([]);
  });

  it('keeps TYPE_ONLY trimmed to files that still exist', () => {
    const stale = [...TYPE_ONLY].filter((relPath) => !sourceFiles.includes(relPath));
    expect(stale).toEqual([]);
  });
});
