/**
 * Oracle conformance — Storage rules.
 *
 * The Storage counterpart of test/rules/oracle-conformance.test.ts. It wires
 * `scripts/oracle/observations/rules-storage-*.json` into the test suite so
 * captured production Rules-Test-API verdicts are MACHINE-CHECKED against the
 * in-process storage evaluator (`evaluateStorageRules`), not merely cited.
 *
 * Data-driven by design: each observation's name is `rules-storage-<id>`,
 * where `<id>` is a corpus pack id. For every captured observation the suite
 * loads the matching pack, runs the LOCAL evaluator over the same ruleset +
 * cases, and asserts the evaluator's per-case decision equals the captured
 * production verdict. Coverage is structural: an observation whose id has no
 * corresponding pack FAILS loudly (a capture can't silently go un-checked) —
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
 * `scripts/oracle/run-rules-storage.ts` with PARITY_SA_BASE64 to produce them.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_RULES_STORAGE_PACKS,
  RULES_STORAGE_OBSERVATION_PREFIX,
  storageObservationName,
  type StoragePack,
} from '../../../../scripts/oracle/rules-corpus/storage/index.ts';
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

const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'oracle', 'observations');

/** name (no extension) → pack, for O(1) observation→pack resolution. */
const PACK_BY_OBSERVATION = new Map<string, StoragePack>(
  ALL_RULES_STORAGE_PACKS.map((pack) => [storageObservationName(pack), pack]),
);

interface RulesObservation {
  name: string;
  behavior: Record<string, unknown>;
}

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
  const existing = tc.existingResource
    ? {
        size: tc.existingResource.size ?? 0,
        contentType: tc.existingResource.contentType,
        metadata: tc.existingResource.metadata,
      }
    : null;
  return { request, resource: existing };
}

/** Evaluator decision per case, keyed by case description (the same key the
 *  capture uses) so the two tables line up 1:1. */
function evaluatorVerdicts(pack: StoragePack): Record<string, 'ALLOW' | 'DENY'> {
  const rules = parseStorageRules(pack.rules);
  const table: Record<string, 'ALLOW' | 'DENY'> = {};
  for (const tc of pack.cases) {
    const now = tc.requestTime ? new Date(tc.requestTime) : undefined;
    const res = evaluateStorageRules(rules, toEvaluationInput(tc), now, lookupFromCase(tc));
    table[tc.description] = res.allowed ? 'ALLOW' : 'DENY';
  }
  return table;
}

describe('oracle conformance (rules-storage)', () => {
  const files = capturedObservationFiles();

  // Corpus sanity: every pack must parse. This runs even with no observations,
  // so a malformed ruleset is caught at staging time, not only at capture.
  it('every storage corpus pack parses', () => {
    for (const pack of ALL_RULES_STORAGE_PACKS) {
      expect(() => parseStorageRules(pack.rules), `pack "${pack.id}" must parse`).not.toThrow();
    }
  });

  // ── empty-set guard: pass + skip the replay while nothing is captured ──────
  if (files.length === 0) {
    it('no rules-storage observations captured yet (staging) — skipping replay', () => {
      // Intentionally passes: the machinery is staged, the corpus is in place,
      // but no captures have been run. Run `scripts/oracle/run-rules-storage.ts`
      // with PARITY_SA_BASE64 to produce observations, after which these
      // assertions go live automatically.
      expect(files.length).toBe(0);
    });
  }

  // ── verdict-for-verdict replay (live the moment observations exist) ────────
  for (const file of files) {
    const obs = loadObservation(file);
    const pack = PACK_BY_OBSERVATION.get(obs.name);

    it(`${obs.name}: evaluator matches captured production verdicts`, () => {
      // Completeness is structural: an observation with no corpus pack is a
      // silent-gap failure — either the pack was removed or the file is stale.
      expect(
        pack,
        `observation "${obs.name}" has no matching corpus pack — coverage gap`,
      ).toBeDefined();
      if (!pack) return;

      // Cases marked knownGap are exercised but not asserted (the evaluator has
      // no UNSUPPORTED channel; it denies a field it does not model).
      const knownGap = new Set(
        pack.cases.filter((c) => c.knownGap).map((c) => c.description),
      );

      const evalTable = evaluatorVerdicts(pack);
      for (const [caseKey, prodVerdict] of Object.entries(obs.behavior)) {
        if (knownGap.has(caseKey)) continue;
        expect(evalTable[caseKey], `${obs.name} :: ${caseKey}`).toBe(prodVerdict);
      }
    });
  }

  // ── coverage: no captured observation is left un-replayed ──────────────────
  it('every captured rules-storage observation maps to a corpus pack', () => {
    const uncovered = capturedObservationFiles()
      .map((f) => f.replace(/\.json$/, ''))
      .filter((name) => !PACK_BY_OBSERVATION.has(name));
    expect(uncovered).toEqual([]);
  });
});
