/**
 * Oracle conformance — RTDB rules (in-process simulator vs frozen production).
 *
 * The RTDB counterpart of test/rules/oracle-conformance.test.ts (Firestore) and
 * test/storage/rules-oracle-conformance.test.ts (Storage). Unlike those two,
 * RTDB has NO server-side rules test API, so its production truth is captured by
 * DEPLOYING real rulesets, running ops against the live database, observing
 * allow/deny, and restoring — the `rtdb-simulator-vs-prod-agreement` oracle
 * probe. The `rules-corpus/rtdb/` scenarios are a decomposition of that probe (one
 * ruleset per scenario), and every case's `expectation` IS the production verdict
 * that probe froze. This suite runs the SAME (ruleset, op) tuples through the
 * in-process RTDB rules engine and asserts the simulator's allow/deny matches
 * the recorded production verdict — verdict for verdict.
 *
 * Because the prod-derived expectations live in the corpus itself (baked from
 * the frozen agreement observation), this replay is LIVE immediately — it does
 * not wait for a fresh `rules-rtdb-*` capture. When such captures do land, the
 * captured-observation cross-check below additionally asserts each capture's
 * verdict equals the corpus expectation, and completeness (no capture is left
 * un-replayed).
 *
 * KNOWN DIVERGENCES: a case where the simulator disagrees with the recorded
 * production verdict is a real divergence candidate, NOT a test to weaken. Such
 * a case is pinned in KNOWN_DIVERGENCES asserting BOTH sides (prod verdict AND
 * simulator verdict) so the suite stays green today but fails loudly the moment
 * either side moves, and is enumerated by the "enumerate simulator-vs-prod
 * divergences" test so it can never hide.
 *
 * CURRENT STATE: the in-process simulator agrees with every captured
 * production verdict. The r15 ancestor-validate false ALLOW is resolved: the
 * simulator now evaluates the full root-to-write validation path against the
 * merged post-write tree.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { compileRtdbRules } from '../../../src/rules/rtdb/compiled-rules.js';
import {
  ALL_RULES_RTDB_SCENARIOS,
  RULES_RTDB_OBSERVATION_PREFIX,
  rtdbObservationName,
  type RtdbScenario,
} from '../../../../../packages/conformance/rules-corpus/rtdb/index.ts';
import { replayRtdbScenario } from '../../../../../packages/conformance/src/rules-rtdb-replay.ts';

// rules-rtdb-* observations live under the 'rtdb-rules' surface subdirectory
// (surfaces/rtdb-rules.ts owns the prefix), NOT the SDK-plane 'rtdb' one.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'rtdb-rules');

/**
 * Recorded simulator-vs-production divergences, pinned per the Firestore/Storage
 * KNOWN_DIVERGENCES convention: genuine, tracked gaps — never silently skipped.
 * Each entry pins BOTH sides so the suite stays green today but fails loudly the
 * moment either side's actual behavior changes, forcing a revisit.
 *
 * Empty today. A regression or new divergence fails the replay assertion and
 * the enumerator below until it is fixed or pinned with both sides.
 *
 * Keyed by `${scenarioId} :: ${caseDescription}`.
 */
const KNOWN_DIVERGENCES: Record<
  string,
  { prodVerdict: 'ALLOW' | 'DENY'; simVerdict: 'ALLOW' | 'DENY'; reason: string }
> = {};

interface RulesObservation {
  name: string;
  behavior: Record<string, unknown>;
}

const SCENARIO_BY_OBSERVATION = new Map<string, RtdbScenario>(
  ALL_RULES_RTDB_SCENARIOS.map((scenario) => [rtdbObservationName(scenario), scenario]),
);

function loadObservation(file: string): RulesObservation {
  const raw = JSON.parse(readFileSync(join(OBS_DIR, file), 'utf8')) as {
    name?: string;
    behavior?: Record<string, unknown>;
  };
  return { name: raw.name ?? file.replace(/\.json$/, ''), behavior: raw.behavior ?? {} };
}

function capturedObservationFiles(): string[] {
  return readdirSync(OBS_DIR)
    .filter((f) => f.startsWith(RULES_RTDB_OBSERVATION_PREFIX) && f.endsWith('.json'))
    .sort();
}

describe('oracle conformance (rules-rtdb)', () => {
  // Corpus sanity: every scenario's subtree must compile. Runs regardless of
  // captures, so a malformed ruleset is caught here, not only at capture.
  it('every rtdb corpus scenario compiles', () => {
    for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
      const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
      expect(
        () => compileRtdbRules({ rules: { '.read': false, '.write': false, [scenario.id]: subtree } }),
        `scenario "${scenario.id}" must compile`,
      ).not.toThrow();
    }
  });

  // ── verdict-for-verdict replay against the prod-derived corpus expectations ──
  for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
    it(`${rtdbObservationName(scenario)}: simulator matches frozen production verdicts`, () => {
      for (const result of replayRtdbScenario(scenario)) {
        const key = `${scenario.id} :: ${result.caseKey}`;
        const known = KNOWN_DIVERGENCES[key];
        if (known) {
          // Pinned divergence: assert BOTH sides so the pin fails loudly the
          // moment production's recorded verdict or the simulator's behavior moves.
          expect(result.production, `${key} (recorded production verdict)`).toBe(known.prodVerdict);
          expect(result.simulator, `${key} (simulator verdict)`).toBe(known.simVerdict);
          continue;
        }
        expect(result.simulator, key).toBe(result.production);
      }
    });
  }

  // ── enumerate divergences prominently (findings, not hidden skips) ──────────
  it('enumerate simulator-vs-prod divergences (findings)', () => {
    const found: string[] = [];
    for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
      for (const result of replayRtdbScenario(scenario)) {
        const key = `${scenario.id} :: ${result.caseKey}`;
        if (result.simulator !== result.production) {
          found.push(`${key} — prod ${result.production}, sim ${result.simulator}`);
        }
      }
    }
    // Every divergence found must be an explicitly-pinned, tracked one; an
    // unpinned divergence is a NEW finding and fails here.
    const unpinned = found.filter((f) => {
      const key = f.split(' — ')[0];
      return !KNOWN_DIVERGENCES[key];
    });
    expect(unpinned, `unpinned simulator-vs-prod divergences: ${JSON.stringify(unpinned, null, 2)}`).toEqual([]);
    // And every pinned divergence must actually still diverge (no stale pins).
    const foundKeys = new Set(found.map((f) => f.split(' — ')[0]));
    const stalePins = Object.keys(KNOWN_DIVERGENCES).filter((k) => !foundKeys.has(k));
    expect(stalePins, `stale divergence pins (no longer diverging): ${JSON.stringify(stalePins)}`).toEqual([]);
  });

  // ── captured-observation cross-check (live the moment captures exist) ───────
  // A fresh rules-rtdb-<id>.json capture re-confirms production truth. Assert
  // the corpus expectation equals the captured verdict for every case, and that
  // no captured observation is left without a corpus scenario.
  const files = capturedObservationFiles();
  for (const file of files) {
    const obs = loadObservation(file);
    const scenario = SCENARIO_BY_OBSERVATION.get(obs.name);
    it(`${obs.name}: corpus expectations match captured production verdicts`, () => {
      expect(scenario, `observation "${obs.name}" has no matching corpus scenario — coverage gap`).toBeDefined();
      if (!scenario) return;
      const expByDesc = new Map(scenario.cases.map((c) => [c.description, c.expectation]));
      for (const [caseKey, capturedVerdict] of Object.entries(obs.behavior)) {
        const corpusExpectation = expByDesc.get(caseKey);
        expect(corpusExpectation, `${obs.name} :: ${caseKey} — captured case has no corpus twin`).toBeDefined();
        expect(corpusExpectation, `${obs.name} :: ${caseKey} (corpus expectation vs captured verdict)`).toBe(capturedVerdict);
      }
    });
  }

  it('every captured rules-rtdb observation maps to a corpus scenario', () => {
    const uncovered = capturedObservationFiles()
      .map((f) => f.replace(/\.json$/, ''))
      .filter((name) => !SCENARIO_BY_OBSERVATION.has(name));
    expect(uncovered).toEqual([]);
  });
});
