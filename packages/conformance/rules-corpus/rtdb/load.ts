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
import type {
  RtdbDeployScenario,
  RtdbDeployScenarioRecord,
  RtdbScenario,
  RtdbScenarioRecord,
} from './types.ts';

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const NON_RECORD_FILES = new Set(['types.ts', 'load.ts', 'index.ts']);

/** A scenario id must be safe as a filename stem and as an observation filename
 *  segment (`rules-rtdb-<id>.json`): lowercase alphanumerics and single
 *  interior hyphens, no leading/trailing hyphen. */
const FILENAME_SAFE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const EXPECTATIONS = new Set(['ALLOW', 'DENY']);
const OPERATIONS = new Set(['read', 'write', 'update', 'query']);
const QUERY_ORDERS = ['orderByChild', 'orderByKey', 'orderByValue', 'orderByPriority'] as const;
const QUERY_FIELDS = new Set<string>([
  ...QUERY_ORDERS, 'equalTo', 'startAt', 'endAt', 'limitToFirst', 'limitToLast',
]);
const DEPLOY_VERDICTS = new Set(['ACCEPTED', 'REJECTED']);

/** Validation shared by operation and deploy scenarios. */
function commonProblems(
  id: string,
  value: unknown,
  fail: (message: string) => void,
): Record<string, unknown> | undefined {
  if (!FILENAME_SAFE_ID.test(id)) {
    fail(`scenario id '${id}' (derived from filename) is not filename-safe — expected lowercase alphanumerics and single interior hyphens`);
  }

  if (typeof value !== 'object' || value === null) {
    fail("does not export a 'scenario' record object");
    return undefined;
  }
  const record = value as Record<string, unknown>;

  if ('id' in record) fail("authored record must not declare its own 'id' — the filename is the id");
  if (typeof record.fm !== 'string' || !record.fm.trim()) fail("missing 'fm'");
  if (typeof record.rationale !== 'string' || !record.rationale.trim()) fail("missing 'rationale'");
  if (typeof record.provenance !== 'string' || !record.provenance.trim()) {
    fail("missing 'provenance' — RTDB scenarios must cite the frozen seed observation they were decomposed from");
  }
  return record;
}

function isJson(text: unknown): boolean {
  if (typeof text !== 'string' || !text.trim()) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Structural validation for one deploy scenario record. */
function deployRecordProblems(file: string, id: string, value: unknown): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`rules-corpus/rtdb/${file}: ${message}`);
  const record = commonProblems(id, value, fail);
  if (!record) return problems;
  if ('cases' in record || 'rules' in record) {
    fail("a deploy scenario declares 'deployCases' only, not 'rules' or 'cases'");
  }
  if (!Array.isArray(record.deployCases) || record.deployCases.length === 0) {
    fail("'deployCases' must be a non-empty array");
    return problems;
  }
  const descriptions = new Set<string>();
  for (const [i, entry] of (record.deployCases as unknown[]).entries()) {
    const c = entry as Record<string, unknown> | null;
    if (typeof c !== 'object' || c === null) {
      fail(`deployCases[${i}] is not an object`);
      continue;
    }
    const label = typeof c.description === 'string' ? c.description : String(i);
    if (typeof c.description !== 'string' || !c.description.trim()) {
      fail(`deployCases[${i}]: missing 'description'`);
    } else {
      if (descriptions.has(c.description)) fail(`duplicate deploy case description '${c.description}'`);
      descriptions.add(c.description);
    }
    if (typeof c.construct !== 'string' || !c.construct.startsWith('rtdb.')) {
      fail(`deployCases[${i}] ('${label}'): 'construct' must name an rtdb.* construct`);
    }
    if (!isJson(c.rules)) fail(`deployCases[${i}] ('${label}'): 'rules' must be a JSON string`);
    const expectation = c.expectation as Record<string, unknown> | undefined;
    if (!expectation || typeof expectation.verdict !== 'string' || !DEPLOY_VERDICTS.has(expectation.verdict)) {
      fail(`deployCases[${i}] ('${label}'): 'expectation.verdict' must be 'ACCEPTED' or 'REJECTED'`);
    } else if (expectation.verdict === 'REJECTED' && (typeof expectation.error !== 'string' || !expectation.error.trim())) {
      fail(`deployCases[${i}] ('${label}'): a REJECTED expectation records production's error text`);
    }
  }
  return problems;
}

/** Structural validation for one authored record. Returns problems found
 *  (empty = valid). */
function recordProblems(file: string, id: string, value: unknown): string[] {
  const problems: string[] = [];
  const fail = (message: string) => problems.push(`rules-corpus/rtdb/${file}: ${message}`);
  const record = commonProblems(id, value, fail);
  if (!record) return problems;
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
      fail(`cases[${i}] ('${c.description ?? i}'): invalid 'operation' (${JSON.stringify(c.operation)}): must be 'read', 'write', 'update' or 'query'`);
    }
    if (c.operation === 'query') {
      const query = c.query as Record<string, unknown> | undefined;
      if (typeof query !== 'object' || query === null || Array.isArray(query)) {
        fail(`cases[${i}] ('${c.description ?? i}'): a 'query' case declares a 'query' object`);
      } else {
        const unknownFields = Object.keys(query).filter((key) => !QUERY_FIELDS.has(key));
        if (unknownFields.length > 0) fail(`cases[${i}] ('${c.description ?? i}'): unknown query fields ${unknownFields.join(', ')}`);
        if (QUERY_ORDERS.filter((key) => key in query).length > 1) {
          fail(`cases[${i}] ('${c.description ?? i}'): a query orders by one of ${QUERY_ORDERS.join(', ')} at most`);
        }
      }
    } else if (c.query !== undefined) {
      fail(`cases[${i}] ('${c.description ?? i}'): only a 'query' case declares 'query'`);
    }
    if (c.claims !== undefined) {
      if (typeof c.claims !== 'object' || c.claims === null || Array.isArray(c.claims)) {
        fail(`cases[${i}] ('${c.description ?? i}'): 'claims' must be an object`);
      } else if (c.authPresent !== true) {
        fail(`cases[${i}] ('${c.description ?? i}'): 'claims' requires 'authPresent: true'`);
      }
    }
    if (c.identity !== undefined) {
      if (typeof c.identity !== 'object' || c.identity === null || Array.isArray(c.identity)) {
        fail(`cases[${i}] ('${c.description ?? i}'): 'identity' must be an object`);
      } else if (c.authPresent !== true) {
        fail(`cases[${i}] ('${c.description ?? i}'): 'identity' requires 'authPresent: true'`);
      } else if (c.claims !== undefined) {
        fail(`cases[${i}] ('${c.description ?? i}'): a case declares 'identity' or 'claims', not both`);
      }
    }
    const isPatch = typeof c.newData === 'object' && c.newData !== null && !Array.isArray(c.newData);
    if (c.operation === 'update' && !isPatch) {
      fail(`cases[${i}] ('${c.description ?? i}'): an 'update' case's 'newData' must be a patch object keyed by relative paths`);
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

export interface LoadedRtdbCorpus {
  /** Scenarios whose cases run operations against a deployed subtree. */
  scenarios: RtdbScenario[];
  /** Scenarios whose cases ask the deploy endpoint to accept a ruleset. */
  deployScenarios: RtdbDeployScenario[];
}

/** Loads every RTDB rules scenario in this directory, validating each record and
 *  injecting its id from the filename. A record with `deployCases` is a deploy
 *  scenario; every other record is an operation scenario. Throws with every
 *  problem found rather than silently dropping a bad file. */
export function loadRtdbCorpus(): LoadedRtdbCorpus {
  const files = readdirSync(HERE)
    .filter((file) => file.endsWith('.ts') && !NON_RECORD_FILES.has(file))
    .sort();

  const problems: string[] = [];
  const scenarios: RtdbScenario[] = [];
  const deployScenarios: RtdbDeployScenario[] = [];

  for (const file of files) {
    const id = file.slice(0, -'.ts'.length);
    const mod = require(join(HERE, file)) as {
      scenario?: RtdbScenarioRecord | RtdbDeployScenarioRecord;
      default?: RtdbScenarioRecord | RtdbDeployScenarioRecord;
    };
    const record = mod.scenario ?? mod.default;
    const isDeploy = typeof record === 'object' && record !== null && 'deployCases' in record;
    const recordFailures = isDeploy ? deployRecordProblems(file, id, record) : recordProblems(file, id, record);
    if (recordFailures.length > 0) {
      problems.push(...recordFailures);
      continue;
    }
    if (isDeploy) deployScenarios.push({ id, ...(record as RtdbDeployScenarioRecord) });
    else scenarios.push({ id, ...(record as RtdbScenarioRecord) });
  }

  if (problems.length > 0) {
    throw new Error(`RTDB rules corpus loading failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return {
    scenarios: scenarios.sort((a, b) => a.id.localeCompare(b.id)),
    deployScenarios: deployScenarios.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** The loaded corpus, evaluated once. */
export const loadedRtdbCorpus: LoadedRtdbCorpus = loadRtdbCorpus();
