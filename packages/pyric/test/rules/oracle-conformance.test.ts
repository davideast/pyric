/**
 * Oracle conformance — Firestore rules.
 *
 * The counterpart of the auth exemplar (test/auth/oracle-conformance.test.ts)
 * for the Firestore rules surface. It wires
 * `packages/conformance/observations/firestore-rules/rules-firestore-*.json` into the test suite so
 * captured production Rules-Test-API verdicts are MACHINE-CHECKED against the
 * in-process sandbox simulator, not merely cited.
 *
 * Data-driven by design: each observation's name is `rules-firestore-<id>`,
 * where `<id>` is a corpus scenario id. For every captured observation the suite
 * loads the matching scenario from the corpus, runs the LOCAL simulator over the
 * same ruleset + cases, and asserts the simulator's per-case decision equals
 * the captured production verdict. The corpus is the single source, so
 * coverage is structural: an observation whose id has no corresponding scenario
 * FAILS loudly (a capture can't silently go un-checked).
 *
 * STAGING STATE: no `rules-firestore-*` observation has been captured yet
 * (no credentials were available to the staging branch, and no observation
 * files were fabricated). While the observation set is empty this suite
 * SKIPS with a clear message and passes. The moment a capture lands, the
 * assertions below go live verdict-for-verdict with no further edits — run
 * `packages/conformance/src/run-rules.ts` with PARITY_SA_BASE64 to produce them.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_RULES_FIRESTORE_SCENARIOS,
  RULES_FIRESTORE_OBSERVATION_PREFIX,
  observationName,
  type Scenario,
} from '../../../../packages/conformance/rules-corpus/firestore/index.ts';
import { allCompatibilityRows } from '../../../../packages/conformance/registry/index.ts';

// rules-firestore-* observations live under the native 'firestore-rules'
// conformance surface (issue #184) — distinct from the SDK-surface 'firestore'
// dir. The capture runner (run-rules.ts) writes here; read from the same place.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'firestore-rules');

/** name (no extension) → scenario, for O(1) observation→scenario resolution. */
const SCENARIO_BY_OBSERVATION = new Map<string, Scenario>(
  ALL_RULES_FIRESTORE_SCENARIOS.map((scenario) => [observationName(scenario), scenario]),
);
const ROW_STATUS = new Map(
  allCompatibilityRows
    .filter(({ surface }) => surface === 'firestore-rules')
    .map(({ id, status }) => [id, status]),
);

interface RulesObservation {
  name: string;
  rowIds: string[];
  behavior: Record<string, unknown>;
}

/**
 * Known simulator/production divergences, pinned per the auth and firestore
 * exemplars' KNOWN DIVERGENCE convention (see test/auth/oracle-conformance.test.ts
 * row-31, test/firestore/oracle-conformance.test.ts firestore-limittolast-preconditions):
 * these are genuine, tracked gaps (#135), not silently skipped cases. Each entry
 * pins BOTH sides — the captured production verdict and the simulator's current
 * verdict — so the suite stays green today but fails loudly the moment the
 * simulator's actual behavior changes on one of these cases, forcing a revisit.
 *
 * Keyed by `${observationName} :: ${caseKey}`.
 */
const KNOWN_DIVERGENCES: Record<
  string,
  { prodVerdict: 'ALLOW' | 'DENY'; simVerdict: 'ALLOW' | 'DENY'; reason: string; issue: string }
> = {
  "rules-firestore-get-after-and-exists-after :: getAfter target == request.resource.data ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator getAfter() does not model the post-write document identity production compares against',
    issue: '#135',
  },
  "rules-firestore-get-after-and-exists-after :: existsAfter create true ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() on a create does not match production post-write existence semantics',
    issue: '#135',
  },
  "rules-firestore-get-after-and-exists-after :: existsAfter delete false ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() on a delete does not match production post-write existence semantics',
    issue: '#135',
  },
  "rules-firestore-get-after-and-exists-after :: existsAfter unrelated mocked path ALLOW": {
    prodVerdict: 'DENY',
    simVerdict: 'ALLOW',
    reason: 'simulator existsAfter() over an unrelated mocked path does not match production',
    issue: '#135',
  },
};

function loadObservation(file: string): RulesObservation {
  const raw = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as {
    name?: string;
    rowIds?: string[];
    behavior?: Record<string, unknown>;
  };
  return {
    name: raw.name ?? file.replace(/\.json$/, ''),
    rowIds: raw.rowIds ?? [],
    behavior: raw.behavior ?? {},
  };
}

/** Every captured `rules-firestore-*.json` in the observations directory. */
function capturedObservationFiles(): string[] {
  return readdirSync(OBS_DIR)
    .filter((f) => f.startsWith(RULES_FIRESTORE_OBSERVATION_PREFIX) && f.endsWith('.json'))
    .sort();
}

/** Simulator decision per case, keyed the same way the capture keys verdicts
 *  (by case description) so the two tables line up 1:1. The simulator (and its
 *  parser/evaluator dependency graph) is imported lazily so the empty-set guard
 *  path runs without loading it. */
async function simulateVerdicts(scenario: Scenario): Promise<Record<string, 'ALLOW' | 'DENY' | 'UNSUPPORTED'>> {
  const { SimulateFirestoreRulesHandler } = await import('../../src/rules/simulator/handler.js');
  const sim = new SimulateFirestoreRulesHandler();
  const res = sim.simulate(scenario.rules, scenario.cases);
  if (!res.success) {
    throw new Error(`simulator failed for scenario "${scenario.id}": ${res.error.code} ${res.error.message}`);
  }
  const table: Record<string, 'ALLOW' | 'DENY' | 'UNSUPPORTED'> = {};
  res.data.results.forEach((r, i) => {
    table[scenario.cases[i].description] = r.decision;
  });
  return table;
}

describe('oracle conformance (rules-firestore)', () => {
  const files = capturedObservationFiles();

  // ── empty-set guard: pass + skip while nothing is captured ──────────────
  if (files.length === 0) {
    it('no rules-firestore observations captured yet (staging) — skipping replay', () => {
      // Intentionally passes: the machinery is staged, the corpus is in place,
      // but no captures have been run. Run `packages/conformance/src/run-rules.ts` with
      // PARITY_SA_BASE64 to produce observations, after which these assertions
      // go live automatically.
      expect(files.length).toBe(0);
    });
  }

  // ── verdict-for-verdict replay (live the moment observations exist) ──────
  for (const file of files) {
    const obs = loadObservation(file);
    const scenario = SCENARIO_BY_OBSERVATION.get(obs.name);
    if (obs.rowIds.length !== 1) {
      throw new Error(`observation "${obs.name}" must name exactly one Firestore Rules row; got ${obs.rowIds.join(', ') || '(none)'}`);
    }
    const rowId = obs.rowIds[0]!;

    it(`${rowId}: ${obs.name}: simulator matches captured production verdicts`, async () => {
      // Completeness is structural: an observation with no corpus scenario is a
      // silent-gap failure — either the scenario was removed or the file is stale.
      expect(
        scenario,
        `observation "${obs.name}" has no matching corpus scenario — coverage gap`,
      ).toBeDefined();
      if (!scenario) return;

      expect(
        Object.keys(obs.behavior).sort(),
        `observation "${obs.name}" must contain exactly the current scenario case set; recapture after adding, removing, or renaming a case`,
      ).toEqual(scenario.cases.map(({ description }) => description).sort());

      const sim = await simulateVerdicts(scenario);
      // Every case in the scenario is checked and any mismatch is collected here
      // rather than asserted immediately — bun aborts a test at the first
      // thrown `expect`, so asserting per-case would hide later divergences
      // behind an earlier one. Collecting first and asserting once at the end
      // (below) means every diverging case in the scenario is reported together.
      const mismatches: string[] = [];
      for (const [caseKey, prodVerdict] of Object.entries(obs.behavior)) {
        const simVerdict = sim[caseKey];
        const divergenceKey = `${obs.name} :: ${caseKey}`;
        // Abstention is only valid when the registry says the row is
        // unsupported. A conforming row may not turn every case into
        // UNSUPPORTED and receive accidental credit.
        if (simVerdict === 'UNSUPPORTED') {
          if (ROW_STATUS.get(rowId) !== 'unsupported') {
            mismatches.push(`${divergenceKey}: simulator abstained but ${rowId} is ${ROW_STATUS.get(rowId) ?? 'missing'}`);
          }
          continue;
        }
        const known = KNOWN_DIVERGENCES[divergenceKey];
        if (known) {
          // Pinned, tracked gap (see KNOWN_DIVERGENCES above): the captured
          // production verdict AND the simulator's current verdict must both
          // still match what was pinned, so neither can silently drift. If
          // the simulator's behavior ever changes on this case, that's
          // reported below and the entry must be revisited.
          if (prodVerdict !== known.prodVerdict) {
            mismatches.push(
              `${divergenceKey} (recorded prod verdict): expected ${JSON.stringify(known.prodVerdict)}, got ${JSON.stringify(prodVerdict)}`,
            );
          }
          if (simVerdict !== known.simVerdict) {
            mismatches.push(
              `${divergenceKey} (recorded sim verdict, ${known.issue}: ${known.reason}): expected ${JSON.stringify(known.simVerdict)}, got ${JSON.stringify(simVerdict)}`,
            );
          }
          continue;
        }
        if (simVerdict !== prodVerdict) {
          mismatches.push(`${divergenceKey}: expected ${JSON.stringify(prodVerdict)}, got ${JSON.stringify(simVerdict)}`);
        }
      }
      expect(mismatches).toEqual([]);
    });
  }

  // ── coverage: no captured observation is left un-replayed ────────────────
  it('every captured rules-firestore observation maps to a corpus scenario', () => {
    const uncovered = capturedObservationFiles()
      .map((f) => f.replace(/\.json$/, ''))
      .filter((name) => !SCENARIO_BY_OBSERVATION.has(name));
    expect(uncovered).toEqual([]);
  });
});
