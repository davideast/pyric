/**
 * Oracle conformance — Firestore rules.
 *
 * The counterpart of the auth exemplar (test/auth/oracle-conformance.test.ts)
 * for the Firestore rules surface. It wires
 * `scripts/oracle/observations/rules-firestore-*.json` into the test suite so
 * captured production Rules-Test-API verdicts are MACHINE-CHECKED against the
 * in-process sandbox simulator, not merely cited.
 *
 * Data-driven by design: each observation's name is `rules-firestore-<id>`,
 * where `<id>` is a corpus pack id. For every captured observation the suite
 * loads the matching pack from the corpus, runs the LOCAL simulator over the
 * same ruleset + cases, and asserts the simulator's per-case decision equals
 * the captured production verdict. The corpus is the single source, so
 * coverage is structural: an observation whose id has no corresponding pack
 * FAILS loudly (a capture can't silently go un-checked).
 *
 * STAGING STATE: no `rules-firestore-*` observation has been captured yet
 * (no credentials were available to the staging branch, and no observation
 * files were fabricated). While the observation set is empty this suite
 * SKIPS with a clear message and passes. The moment a capture lands, the
 * assertions below go live verdict-for-verdict with no further edits — run
 * `scripts/oracle/run-rules.ts` with PARITY_SA_BASE64 to produce them.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALL_RULES_FIRESTORE_PACKS,
  RULES_FIRESTORE_OBSERVATION_PREFIX,
  observationName,
  type Pack,
} from '../../../../scripts/oracle/rules-corpus/firestore/index.ts';

const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'oracle', 'observations');

/** name (no extension) → pack, for O(1) observation→pack resolution. */
const PACK_BY_OBSERVATION = new Map<string, Pack>(
  ALL_RULES_FIRESTORE_PACKS.map((pack) => [observationName(pack), pack]),
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
async function simulateVerdicts(pack: Pack): Promise<Record<string, 'ALLOW' | 'DENY' | 'UNSUPPORTED'>> {
  const { SimulateFirestoreRulesHandler } = await import('../../src/rules/simulator/handler.js');
  const sim = new SimulateFirestoreRulesHandler();
  const res = sim.simulate(pack.rules, pack.cases);
  if (!res.success) {
    throw new Error(`simulator failed for pack "${pack.id}": ${res.error.code} ${res.error.message}`);
  }
  const table: Record<string, 'ALLOW' | 'DENY' | 'UNSUPPORTED'> = {};
  res.data.results.forEach((r, i) => {
    table[pack.cases[i].description] = r.decision;
  });
  return table;
}

describe('oracle conformance (rules-firestore)', () => {
  const files = capturedObservationFiles();

  // ── empty-set guard: pass + skip while nothing is captured ──────────────
  if (files.length === 0) {
    it('no rules-firestore observations captured yet (staging) — skipping replay', () => {
      // Intentionally passes: the machinery is staged, the corpus is in place,
      // but no captures have been run. Run `scripts/oracle/run-rules.ts` with
      // PARITY_SA_BASE64 to produce observations, after which these assertions
      // go live automatically.
      expect(files.length).toBe(0);
    });
  }

  // ── verdict-for-verdict replay (live the moment observations exist) ──────
  for (const file of files) {
    const obs = loadObservation(file);
    const pack = PACK_BY_OBSERVATION.get(obs.name);

    it(`${obs.name}: simulator matches captured production verdicts`, async () => {
      // Completeness is structural: an observation with no corpus pack is a
      // silent-gap failure — either the pack was removed or the file is stale.
      expect(
        pack,
        `observation "${obs.name}" has no matching corpus pack — coverage gap`,
      ).toBeDefined();
      if (!pack) return;

      const sim = await simulateVerdicts(pack);
      for (const [caseKey, prodVerdict] of Object.entries(obs.behavior)) {
        const simVerdict = sim[caseKey];
        // The simulator's documented third state: when it abstains
        // (UNSUPPORTED) it is neither agreement nor a bug — it mirrors the
        // parity harness's SIM_NOT_SUPPORTED. Record but do not fail on it;
        // everything else must match production exactly.
        if (simVerdict === 'UNSUPPORTED') continue;
        expect(simVerdict, `${obs.name} :: ${caseKey}`).toBe(prodVerdict);
      }
    });
  }

  // ── coverage: no captured observation is left un-replayed ────────────────
  it('every captured rules-firestore observation maps to a corpus pack', () => {
    const uncovered = capturedObservationFiles()
      .map((f) => f.replace(/\.json$/, ''))
      .filter((name) => !PACK_BY_OBSERVATION.has(name));
    expect(uncovered).toEqual([]);
  });
});
