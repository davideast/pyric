/**
 * Firestore rules corpus loader.
 *
 * `rules-corpus/firestore/` is the index: one authored `PackRecord` per file,
 * named `<pack-id>.ts`. This loader reads the directory, requires every pack
 * file (skipping `types.ts`, `load.ts`, and `index.ts`), derives each pack's
 * id from its filename, validates the record, and returns the typed array
 * sorted by id. Adding a pack is adding a file; removing one is deleting a
 * file. Mirrors `rigs/load.ts` / `surfaces/load.ts`.
 *
 * Loading is synchronous (Bun's `require` handles `.ts`), matching
 * `surfaces/load.ts`: every existing consumer of `ALL_RULES_FIRESTORE_PACKS`
 * / `STRESS_PACKS` / `FIX_CLASS_PACKS` (the capture runner, the replay suite,
 * the live parity harness) reads a plain array at module-evaluation time, not
 * a promise — a synchronous loader keeps that contract unchanged.
 *
 * Validation is CI-enforced input, not best-effort: a malformed pack is a
 * hard failure (throw), same contract as the other loaders.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pack, PackGroup, PackRecord } from './types.ts';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const NON_RECORD_FILES = new Set(['types.ts', 'load.ts', 'index.ts']);

/** A pack id must be safe as a filename stem and as an observation filename
 *  segment (`rules-firestore-<id>.json`): lowercase alphanumerics and single
 *  interior hyphens, no leading/trailing hyphen. */
const FILENAME_SAFE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const PACK_GROUPS = new Set<PackGroup>(['stress', 'fix-class']);
const EXPECTATIONS = new Set(['ALLOW', 'DENY']);

/** Structural validation for one authored record. Returns problems found
 *  (empty = valid). */
function recordProblems(file: string, id: string, value: unknown): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`rules-corpus/firestore/${file}: ${message}`);

  if (!FILENAME_SAFE_ID.test(id)) {
    fail(`pack id '${id}' (derived from filename) is not filename-safe — expected lowercase alphanumerics and single interior hyphens`);
  }

  if (typeof value !== 'object' || value === null) {
    fail("does not export a 'pack' record object");
    return problems;
  }
  const record = value as Record<string, unknown>;

  if ('id' in record) fail("authored record must not declare its own 'id' — the filename is the id");
  if (typeof record.fm !== 'string' || !record.fm.trim()) fail("missing 'fm'");
  if (typeof record.rationale !== 'string' || !record.rationale.trim()) fail("missing 'rationale'");
  if (typeof record.rules !== 'string' || !record.rules.trim()) fail("'rules' must be a non-empty string");
  if (typeof record.group !== 'string' || !PACK_GROUPS.has(record.group as PackGroup)) {
    fail(`invalid 'group' (${JSON.stringify(record.group)}) — must be 'stress' or 'fix-class'`);
  }

  if (!Array.isArray(record.cases) || record.cases.length === 0) {
    fail("'cases' must be a non-empty array");
    return problems;
  }
  const descriptions = new Set<string>();
  for (const [i, tc] of (record.cases as unknown[]).entries()) {
    const c = tc as Record<string, unknown> | null;
    if (typeof c !== 'object' || c === null) {
      fail(`cases[${i}] is not an object`);
      continue;
    }
    if (typeof c.description !== 'string' || !c.description.trim()) {
      fail(`cases[${i}]: missing 'description'`);
    } else {
      if (descriptions.has(c.description)) fail(`duplicate case description '${c.description}' — case descriptions must be unique within a pack`);
      descriptions.add(c.description);
    }
    if (typeof c.expectation !== 'string' || !EXPECTATIONS.has(c.expectation)) {
      fail(`cases[${i}] ('${c.description ?? i}'): invalid 'expectation' (${JSON.stringify(c.expectation)}) — must be 'ALLOW' or 'DENY'`);
    }
  }

  return problems;
}

/** Loads every Firestore rules pack in this directory, validating each
 *  record and injecting its id from the filename. Throws with every problem
 *  found rather than silently dropping a bad file. */
export function loadFirestorePackRecords(): (Pack & { group: PackGroup })[] {
  const files = readdirSync(HERE)
    .filter((file) => file.endsWith('.ts') && !NON_RECORD_FILES.has(file))
    .sort();

  const problems: string[] = [];
  const packs: (Pack & { group: PackGroup })[] = [];

  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = require(join(HERE, file)) as { pack?: PackRecord; default?: PackRecord };
    const record = mod.pack ?? mod.default;
    const recordFailures = recordProblems(file, id, record);
    if (recordFailures.length > 0) {
      problems.push(...recordFailures);
      continue;
    }
    const { group, ...rest } = record as PackRecord;
    packs.push({ id, ...rest, group });
  }

  if (problems.length > 0) {
    throw new Error(`Firestore rules corpus loading failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

/** The loaded packs, evaluated once — the `Pack[]` shape every consumer
 *  (capture runner, replay suite, live parity harness) has always seen.
 *  `group` is attached only for `index.ts` to split into STRESS_PACKS /
 *  FIX_CLASS_PACKS; it is not part of the `Pack` type and every other
 *  consumer only ever sees the stripped `Pack` shape. */
export const loadedFirestorePacks: (Pack & { group: PackGroup })[] = loadFirestorePackRecords();
