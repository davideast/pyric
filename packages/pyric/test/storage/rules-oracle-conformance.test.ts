/**
 * Oracle conformance — Storage rules.
 *
 * The Storage counterpart of test/rules/oracle-conformance.test.ts. It wires
 * `packages/conformance/observations/storage-rules/rules-storage-*.json` into the test suite so
 * captured production Rules-Test-API verdicts are MACHINE-CHECKED against the
 * in-process storage evaluator (`evaluateStorageRules`), not merely cited.
 *
 * Data-driven by design: each observation's name is `rules-storage-<id>`,
 * where `<id>` is a corpus scenario id. For every captured observation the suite
 * loads the matching scenario, runs the LOCAL evaluator over the same ruleset +
 * cases, and asserts the evaluator's per-case decision equals the captured
 * production verdict. Coverage is structural: an observation whose id has no
 * corresponding scenario FAILS loudly (a capture can't silently go un-checked) —
 * this completeness check is live even before any data exists.
 *
 * KNOWN-GAP CASES: the storage evaluator has no `UNSUPPORTED` verdict channel
 * (it returns allow/deny), so a case exercising a field the evaluator does not
 * model (e.g. resource.timeCreated) is marked `knownGap` in the corpus. Those
 * cases are RECORDED but NOT ASSERTED here — the exact analogue of the
 * Firestore replay skipping its simulator's UNSUPPORTED abstentions.
 *
 * STAGING STATE: no `rules-storage-*` observation has been captured yet (no
 * credentials were available to the staging branch, and no observation files
 * were fabricated). While the observation set is empty this suite SKIPS the
 * replay with a clear message and passes. The moment a capture lands, the
 * assertions go live verdict-for-verdict with no further edits — run
 * `packages/conformance/src/run-rules-storage.ts` with PARITY_SA_BASE64 to produce them.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_RULES_STORAGE_SCENARIOS,
  RULES_STORAGE_OBSERVATION_PREFIX,
  storageObservationName,
  type StorageScenario,
} from '../../../../packages/conformance/rules-corpus/storage/index.ts';
import {
  normalizeStoragePath,
  type StorageTestCase,
} from '../../src/rules/test/spec.ts';
import {
  parseStorageRules,
  evaluateStorageRules,
  type EvaluationInput,
  type FirestoreLookup,
} from '../../src/storage/rules.ts';

// rules-storage-* observations live under the native 'storage-rules'
// conformance surface (issue #184) — distinct from the SDK-surface 'storage'
// dir. The capture runner (run-rules-storage.ts) writes here; read the same place.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'storage-rules');

/** name (no extension) → scenario, for O(1) observation→scenario resolution. */
const SCENARIO_BY_OBSERVATION = new Map<string, StorageScenario>(
  ALL_RULES_STORAGE_SCENARIOS.map((scenario) => [storageObservationName(scenario), scenario]),
);

interface RulesObservation {
  name: string;
  behavior: Record<string, unknown>;
}

/**
 * Known evaluator/production divergences, pinned per the Firestore exemplar's
 * KNOWN DIVERGENCE convention (test/rules/oracle-conformance.test.ts
 * KNOWN_DIVERGENCES): genuine, tracked gaps — not silently skipped cases.
 * Each entry pins BOTH sides so the suite stays green today but fails loudly
 * the moment either side's actual behavior changes, forcing a revisit.
 *
 * `rules-storage-verbs-umbrella-granular :: create allowed when object does
 * not exist (resource == null)`: live-probed against the production Rules
 * Test API with BOTH an omitted `resource` field and an explicit
 * `resource: null` for a create where the object does not yet exist — both
 * shapes are the harness's correct wire encoding of "no existing object"
 * (`buildStorageApiTestCase` only sets the envelope `resource` when
 * `existingResource` is truthy, so `null`/omitted already send no `resource`
 * key). Production responds to BOTH shapes identically: a "Null value error"
 * at the `resource == null` comparison, and denies — i.e. referencing
 * `resource` when no object exists throws in production's engine rather than
 * evaluating the documented `resource == null` idiom. This rules out a
 * capture-harness bug: the wire shape sent was already correct. The pyric
 * evaluator instead models `resource` as an actual `null` value on create, so
 * `resource == null` evaluates true and allows — the documented, intuitive
 * semantics, but not what production does today.
 *
 * Keyed by `${observationName} :: ${caseKey}`.
 */
const KNOWN_DIVERGENCES: Record<
  string,
  { prodVerdict: 'ALLOW' | 'DENY'; evalVerdict: 'ALLOW' | 'DENY'; reason: string; issue: string }
> = {
  'rules-storage-verbs-umbrella-granular :: create allowed when object does not exist (resource == null)': {
    prodVerdict: 'DENY',
    evalVerdict: 'ALLOW',
    reason:
      'production throws a "Null value error" referencing `resource` on a create where no object exists yet (live-probed with both an omitted resource field and an explicit null — both denied identically), instead of evaluating `resource == null` as documented; the evaluator models resource as null on create and allows, per the documented semantics',
    issue: '#134',
  },
};

function loadObservation(file: string): RulesObservation {
  const raw = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as {
    name?: string;
    behavior?: Record<string, unknown>;
  };
  return {
    name: raw.name ?? file.replace(/\.json$/, ''),
    behavior: raw.behavior ?? {},
  };
}

/** Every captured `rules-storage-*.json` in the observations directory. */
function capturedObservationFiles(): string[] {
  return readdirSync(OBS_DIR)
    .filter((f) => f.startsWith(RULES_STORAGE_OBSERVATION_PREFIX) && f.endsWith('.json'))
    .sort();
}

/** Build a FirestoreLookup from a case's function mocks. The evaluator keys
 *  lookups by the doc path in `collection/doc` form — exactly the corpus mock
 *  `path`. Mocks with no matching entry read as absent (get → null → the rule
 *  denies, exists → false). */
function lookupFromCase(tc: StorageTestCase): FirestoreLookup | undefined {
  if (!tc.functionMocks || tc.functionMocks.length === 0) return undefined;
  const gets = new Map<string, Record<string, unknown>>();
  const exists = new Set<string>();
  for (const m of tc.functionMocks) {
    if (m.function === 'get' && typeof m.result === 'object' && m.result !== null) {
      gets.set(m.path, m.result as Record<string, unknown>);
    } else if (m.function === 'exists' && m.result === true) {
      exists.add(m.path);
    }
  }
  return {
    get: (path) => gets.get(path) ?? null,
    exists: (path) => exists.has(path),
  };
}

/** Map a corpus case to the evaluator's EvaluationInput. */
function toEvaluationInput(tc: StorageTestCase): EvaluationInput {
  const path = normalizeStoragePath(tc.path, tc.bucket);
  const request: EvaluationInput['request'] = {
    auth: tc.auth ?? null,
    method: tc.method,
    path,
  };
  if (tc.resource) {
    request.resource = {
      size: tc.resource.size ?? 0,
      contentType: tc.resource.contentType,
      metadata: tc.resource.metadata,
    };
  }
  // The existing-object binding carries the object-identity/time fields too.
  // They are forwarded VERBATIM from the same corpus field the capture sent to
  // production, so both sides read byte-identical `resource.*` values — the
  // only way the replay's verdict comparison means anything.
  const existing = tc.existingResource
    ? {
        size: tc.existingResource.size ?? 0,
        contentType: tc.existingResource.contentType,
        metadata: tc.existingResource.metadata,
        name: tc.existingResource.name,
        bucket: tc.existingResource.bucket,
        timeCreated: tc.existingResource.timeCreated,
        updated: tc.existingResource.updated,
        generation: tc.existingResource.generation,
        metageneration: tc.existingResource.metageneration,
      }
    : null;
  return { request, resource: existing };
}

/** Evaluator decision per case, keyed by case description (the same key the
 *  capture uses) so the two tables line up 1:1. */
function evaluatorVerdicts(scenario: StorageScenario): Record<string, 'ALLOW' | 'DENY'> {
  const rules = parseStorageRules(scenario.rules);
  const table: Record<string, 'ALLOW' | 'DENY'> = {};
  for (const tc of scenario.cases) {
    const now = tc.requestTime ? new Date(tc.requestTime) : undefined;
    const res = evaluateStorageRules(rules, toEvaluationInput(tc), now, lookupFromCase(tc));
    table[tc.description] = res.allowed ? 'ALLOW' : 'DENY';
  }
  return table;
}

describe('oracle conformance (rules-storage)', () => {
  const files = capturedObservationFiles();

  // Corpus sanity: every scenario must parse. This runs even with no observations,
  // so a malformed ruleset is caught at staging time, not only at capture.
  it('every storage corpus scenario parses', () => {
    for (const scenario of ALL_RULES_STORAGE_SCENARIOS) {
      expect(() => parseStorageRules(scenario.rules), `scenario "${scenario.id}" must parse`).not.toThrow();
    }
  });

  // ── empty-set guard: pass + skip the replay while nothing is captured ──────
  if (files.length === 0) {
    it('no rules-storage observations captured yet (staging) — skipping replay', () => {
      // Intentionally passes: the machinery is staged, the corpus is in place,
      // but no captures have been run. Run `packages/conformance/src/run-rules-storage.ts`
      // with PARITY_SA_BASE64 to produce observations, after which these
      // assertions go live automatically.
      expect(files.length).toBe(0);
    });
  }

  // ── verdict-for-verdict replay (live the moment observations exist) ────────
  for (const file of files) {
    const obs = loadObservation(file);
    const scenario = SCENARIO_BY_OBSERVATION.get(obs.name);

    it(`${obs.name}: evaluator matches captured production verdicts`, () => {
      // Completeness is structural: an observation with no corpus scenario is a
      // silent-gap failure — either the scenario was removed or the file is stale.
      expect(
        scenario,
        `observation "${obs.name}" has no matching corpus scenario — coverage gap`,
      ).toBeDefined();
      if (!scenario) return;

      // Cases marked knownGap are exercised but not asserted (the evaluator has
      // no UNSUPPORTED channel; it denies a field it does not model).
      const knownGap = new Set(
        scenario.cases.filter((c) => c.knownGap).map((c) => c.description),
      );

      const evalTable = evaluatorVerdicts(scenario);
      for (const [caseKey, prodVerdict] of Object.entries(obs.behavior)) {
        if (knownGap.has(caseKey)) continue;
        const divergenceKey = `${obs.name} :: ${caseKey}`;
        const known = KNOWN_DIVERGENCES[divergenceKey];
        if (known) {
          // Pinned, tracked gap: assert BOTH sides so the entry fails loudly
          // the moment production or the evaluator's actual behavior moves.
          expect(prodVerdict, `${divergenceKey} (captured production verdict)`).toBe(known.prodVerdict);
          expect(evalTable[caseKey], `${divergenceKey} (evaluator verdict)`).toBe(known.evalVerdict);
          continue;
        }
        expect(evalTable[caseKey], divergenceKey).toBe(prodVerdict);
      }
    });
  }

  // ── coverage: no captured observation is left un-replayed ──────────────────
  it('every captured rules-storage observation maps to a corpus scenario', () => {
    const uncovered = capturedObservationFiles()
      .map((f) => f.replace(/\.json$/, ''))
      .filter((name) => !SCENARIO_BY_OBSERVATION.has(name));
    expect(uncovered).toEqual([]);
  });
});
