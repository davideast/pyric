/**
 * Storage rules corpus loader.
 *
 * Mirrors `../firestore/load.ts` for the `service firebase.storage` surface.
 * `rules-corpus/storage/` is the index: one authored `StoragePackRecord` per
 * file, named `<pack-id>.ts`. This loader reads the directory, requires
 * every pack file (skipping `types.ts`, `load.ts`, and `index.ts`), derives
 * each pack's id from its filename, validates the record, and returns the
 * typed array sorted by id.
 *
 * Loading is synchronous (Bun's `require` handles `.ts`), for the same
 * reason as the Firestore loader: existing consumers
 * (`ALL_RULES_STORAGE_PACKS`) read a plain array at module-evaluation time.
 *
 * Validation is CI-enforced input, not best-effort: a malformed pack is a
 * hard failure (throw), same contract as the other loaders.
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StoragePack, StoragePackRecord } from './types.ts';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const NON_RECORD_FILES = new Set(['types.ts', 'load.ts', 'index.ts']);

/** A pack id must be safe as a filename stem and as an observation filename
 *  segment (`rules-storage-<id>.json`): lowercase alphanumerics and single
 *  interior hyphens, no leading/trailing hyphen. */
const FILENAME_SAFE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const EXPECTATIONS = new Set(['ALLOW', 'DENY']);

/** Structural validation for one authored record. Returns problems found
 *  (empty = valid). */
function recordProblems(file: string, id: string, value: unknown): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`rules-corpus/storage/${file}: ${message}`);

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

/** Loads every Storage rules pack in this directory, validating each record
 *  and injecting its id from the filename. Throws with every problem found
 *  rather than silently dropping a bad file. */
export function loadStoragePackRecords(): StoragePack[] {
  const files = readdirSync(HERE)
    .filter((file) => file.endsWith('.ts') && !NON_RECORD_FILES.has(file))
    .sort();

  const problems: string[] = [];
  const packs: StoragePack[] = [];

  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = require(join(HERE, file)) as { pack?: StoragePackRecord; default?: StoragePackRecord };
    const record = mod.pack ?? mod.default;
    const recordFailures = recordProblems(file, id, record);
    if (recordFailures.length > 0) {
      problems.push(...recordFailures);
      continue;
    }
    packs.push({ id, ...(record as StoragePackRecord) });
  }

  if (problems.length > 0) {
    throw new Error(`Storage rules corpus loading failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return packs.sort((a, b) => a.id.localeCompare(b.id));
}

/** The loaded packs, evaluated once — the `StoragePack[]` shape every
 *  consumer (capture runner, replay suite) has always seen. */
export const loadedStoragePacks: StoragePack[] = loadStoragePackRecords();
