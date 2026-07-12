/**
 * RTDB rules corpus loader.
 *
 * Mirrors `../firestore/load.ts` / `../storage/load.ts` for the
 * `realtime-database` surface. `rules-corpus/rtdb/` is the index: one authored
 * `RtdbScenarioRecord` per file, named `<scenario-id>.ts`. This loader reads the
 * directory, requires every scenario file (skipping `types.ts`, `load.ts`, and
 * `index.ts`), derives each scenario's id from its filename, validates the record,
 * and returns the typed array sorted by id.
 *
 * Loading is synchronous (Bun's `require` handles `.ts`), for the same reason
 * as the sibling loaders: existing consumers (`ALL_RULES_RTDB_SCENARIOS`) read a
 * plain array at module-evaluation time.
 *
 * Validation is CI-enforced input, not best-effort: a malformed scenario is a hard
 * failure (throw), same contract as the other loaders. Beyond the shared
 * checks (filename-safe ids, unique case descriptions, legal expectations,
 * non-empty rules), RTDB scenarios additionally require a non-empty `provenance`
 * citation and their `rules` must be valid JSON (the deployed subtree).
 */
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RtdbScenario, RtdbScenarioRecord } from './types.ts';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const NON_RECORD_FILES = new Set(['types.ts', 'load.ts', 'index.ts']);

/** A scenario id must be safe as a filename stem and as an observation filename
 *  segment (`rules-rtdb-<id>.json`): lowercase alphanumerics and single
 *  interior hyphens, no leading/trailing hyphen. */
const FILENAME_SAFE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const EXPECTATIONS = new Set(['ALLOW', 'DENY']);
const OPERATIONS = new Set(['read', 'write']);

/** Structural validation for one authored record. Returns problems found
 *  (empty = valid). */
function recordProblems(file: string, id: string, value: unknown): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`rules-corpus/rtdb/${file}: ${message}`);

  if (!FILENAME_SAFE_ID.test(id)) {
    fail(`scenario id '${id}' (derived from filename) is not filename-safe — expected lowercase alphanumerics and single interior hyphens`);
  }

  if (typeof value !== 'object' || value === null) {
    fail("does not export a 'scenario' record object");
    return problems;
  }
  const record = value as Record<string, unknown>;

  if ('id' in record) fail("authored record must not declare its own 'id' — the filename is the id");
  if (typeof record.fm !== 'string' || !record.fm.trim()) fail("missing 'fm'");
  if (typeof record.rationale !== 'string' || !record.rationale.trim()) fail("missing 'rationale'");
  if (typeof record.provenance !== 'string' || !record.provenance.trim()) {
    fail("missing 'provenance' — RTDB scenarios must cite the frozen seed observation they were decomposed from");
  }
  if (typeof record.rules !== 'string' || !record.rules.trim()) {
    fail("'rules' must be a non-empty string");
  } else {
    try {
      JSON.parse(record.rules);
    } catch {
      fail("'rules' must be valid JSON (the deployed RTDB rules subtree)");
    }
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
      if (descriptions.has(c.description)) fail(`duplicate case description '${c.description}' — case descriptions must be unique within a scenario`);
      descriptions.add(c.description);
    }
    if (typeof c.expectation !== 'string' || !EXPECTATIONS.has(c.expectation)) {
      fail(`cases[${i}] ('${c.description ?? i}'): invalid 'expectation' (${JSON.stringify(c.expectation)}) — must be 'ALLOW' or 'DENY'`);
    }
    if (typeof c.operation !== 'string' || !OPERATIONS.has(c.operation)) {
      fail(`cases[${i}] ('${c.description ?? i}'): invalid 'operation' (${JSON.stringify(c.operation)}) — must be 'read' or 'write'`);
    }
    if (typeof c.opPath !== 'string' || !c.opPath.startsWith('/')) {
      fail(`cases[${i}] ('${c.description ?? i}'): 'opPath' must be a string starting with '/'`);
    }
    if (typeof c.authPresent !== 'boolean') {
      fail(`cases[${i}] ('${c.description ?? i}'): 'authPresent' must be a boolean`);
    }
  }

  return problems;
}

/** Loads every RTDB rules scenario in this directory, validating each record and
 *  injecting its id from the filename. Throws with every problem found rather
 *  than silently dropping a bad file. */
export function loadRtdbScenarioRecords(): RtdbScenario[] {
  const files = readdirSync(HERE)
    .filter((file) => file.endsWith('.ts') && !NON_RECORD_FILES.has(file))
    .sort();

  const problems: string[] = [];
  const scenarios: RtdbScenario[] = [];

  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = require(join(HERE, file)) as { scenario?: RtdbScenarioRecord; default?: RtdbScenarioRecord };
    const record = mod.scenario ?? mod.default;
    const recordFailures = recordProblems(file, id, record);
    if (recordFailures.length > 0) {
      problems.push(...recordFailures);
      continue;
    }
    scenarios.push({ id, ...(record as RtdbScenarioRecord) });
  }

  if (problems.length > 0) {
    throw new Error(`RTDB rules corpus loading failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}

/** The loaded scenarios, evaluated once — the `RtdbScenario[]` shape every consumer
 *  (capture runner, replay suite) has always seen. */
export const loadedRtdbScenarios: RtdbScenario[] = loadRtdbScenarioRecords();
