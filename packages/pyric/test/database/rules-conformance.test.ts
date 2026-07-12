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
 * in-process `SimulateHandler` and asserts the simulator's allow/deny matches
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
 * CURRENT STATE: the in-process simulator agrees with production on ALL 29
 * cases — zero live divergences, so KNOWN_DIVERGENCES is empty. The frozen
 * agreement observation (captured 2026-05-18) recorded ONE disagreement:
 * r4-validate-structure's missing-body write (prod DENY, simulator-at-capture
 * ALLOW — the simulator then did not veto on the child `.validate`). The
 * current simulator DENIES that write, matching production; the historical
 * divergence is RESOLVED. The corpus expectation stays the production verdict
 * (DENY), which the current simulator now satisfies without a pin.
 */
import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { RtdbMapper } from '../../src/database/mapper.js';
import { SimulateHandler } from '../../src/database/simulation/handler.js';
import type { SimulationInput } from '../../src/database/simulation/spec.js';
import {
  ALL_RULES_RTDB_SCENARIOS,
  RULES_RTDB_OBSERVATION_PREFIX,
  rtdbObservationName,
  type RtdbScenario,
  type RtdbTestCase,
} from '../../../../packages/conformance/rules-corpus/rtdb/index.ts';

// rules-rtdb-* observations live under the 'rtdb' surface subdirectory.
const OBS_DIR = join(import.meta.dir, '..', '..', '..', '..', 'packages', 'conformance', 'observations', 'rtdb');

/** A fixed replay uid substituted for the `<UID>` token in authed ops — the
 *  in-process analogue of the signed-in anonymous uid the agreement probe
 *  captured. The exact value is immaterial to allow/deny: an owner rule
 *  (`$uid === auth.uid`) holds as long as the path uid and `auth.uid` are the
 *  same string, which this constant guarantees. Anonymous ops substitute the
 *  empty string, exactly as the probe did (signed-out `liveUid = ''`). */
const REPLAY_UID = 'THP041EPnYbzh9c8GGBniSDoUKc2';
const DATABASE_URL = 'https://pyric-oracle.firebaseio.com';

/** Recursively replace the `<UID>` token in a value, mirroring the agreement
 *  probe's substituteUid so replay inputs reconstruct the captured ops. */
function substituteUid<T>(v: T, uid: string): T {
  if (typeof v === 'string') return v.replaceAll('<UID>', uid) as unknown as T;
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((item) => substituteUid(item, uid)) as unknown as T;
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = substituteUid(val, uid);
    return out as unknown as T;
  }
  return v;
}

/** Build the root-relative mock snapshot for a case, exactly as the probe's
 *  buildSimMock: nest `mockData` under the op path's segments so
 *  `data.exists()` at the op path sees it. Empty root when there is no
 *  pre-existing value. */
function buildSimMock(simPath: string, mockData: unknown): Record<string, unknown> {
  if (mockData === undefined || mockData === null) return {};
  const segs = simPath.split('/').filter(Boolean);
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const child: Record<string, unknown> = {};
    cursor[segs[i]] = child;
    cursor = child;
  }
  cursor[segs[segs.length - 1]] = mockData;
  return root;
}

/** The simulator's allow/deny for one case, reconstructing the agreement
 *  probe's simulator input: the scenario subtree mounted under the scenario id beneath
 *  a deny-all root, the op path prefixed with the mount key, and the same auth
 *  context. A simulator error (NO_MATCHING_RULE etc.) reads as DENY, as the
 *  probe did. */
function simulatorVerdict(scenario: RtdbScenario, tc: RtdbTestCase): 'ALLOW' | 'DENY' {
  const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
  const simRulesJson = {
    rules: {
      '.read': false,
      '.write': false,
      [scenario.id]: subtree,
    },
  };
  const ir = RtdbMapper.mapToIR(simRulesJson, null, DATABASE_URL);
  const handler = new SimulateHandler();

  const uid = tc.authPresent ? REPLAY_UID : '';
  const opPath = substituteUid(tc.opPath, uid);
  const newData = tc.newData !== undefined ? substituteUid(tc.newData, uid) : undefined;
  const mockData = tc.mockData !== undefined ? substituteUid(tc.mockData, uid) : undefined;
  const simPath = `/${scenario.id}${opPath}`;

  const input: SimulationInput = {
    operation: tc.operation,
    path: simPath,
    auth: tc.authPresent
      ? { uid, token: { firebase: { sign_in_provider: 'anonymous' }, provider_id: 'anonymous' } }
      : null,
    mockData: buildSimMock(simPath, mockData),
    newData,
  };

  const res = handler.execute(ir, input);
  if (!res.success) return 'DENY';
  return res.data.allowed ? 'ALLOW' : 'DENY';
}

/**
 * Recorded simulator-vs-production divergences, pinned per the Firestore/Storage
 * KNOWN_DIVERGENCES convention: genuine, tracked gaps — never silently skipped.
 * Each entry pins BOTH sides so the suite stays green today but fails loudly the
 * moment either side's actual behavior changes, forcing a revisit.
 *
 * EMPTY today: the current simulator agrees with production on every corpus
 * case. The one historical disagreement — r4-validate-structure's missing-body
 * write, recorded ALLOW by the simulator at capture (2026-05-18) against a prod
 * DENY — has since been fixed (the simulator now vetoes on the child
 * `.validate` and denies), so there is nothing to pin. A future regression that
 * reopens it, or any new divergence, will fail the replay assertion and the
 * "enumerate simulator-vs-prod divergences" test until it is triaged and either
 * fixed or pinned here with both sides and a reason.
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
  // Corpus sanity: every scenario's subtree must map to IR. Runs regardless of
  // captures, so a malformed ruleset is caught here, not only at capture.
  it('every rtdb corpus scenario maps to IR', () => {
    for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
      const subtree = JSON.parse(scenario.rules) as Record<string, unknown>;
      expect(
        () => RtdbMapper.mapToIR({ rules: { '.read': false, '.write': false, [scenario.id]: subtree } }, null, DATABASE_URL),
        `scenario "${scenario.id}" must map to IR`,
      ).not.toThrow();
    }
  });

  // ── verdict-for-verdict replay against the prod-derived corpus expectations ──
  for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
    it(`${rtdbObservationName(scenario)}: simulator matches frozen production verdicts`, () => {
      for (const tc of scenario.cases) {
        if (tc.pendingCapture) continue; // recorded but not assertable yet
        const key = `${scenario.id} :: ${tc.description}`;
        const sim = simulatorVerdict(scenario, tc);
        const known = KNOWN_DIVERGENCES[key];
        if (known) {
          // Pinned divergence: assert BOTH sides so the pin fails loudly the
          // moment production's recorded verdict or the simulator's behavior moves.
          expect(tc.expectation, `${key} (recorded production verdict)`).toBe(known.prodVerdict);
          expect(sim, `${key} (simulator verdict)`).toBe(known.simVerdict);
          continue;
        }
        expect(sim, key).toBe(tc.expectation);
      }
    });
  }

  // ── enumerate divergences prominently (findings, not hidden skips) ──────────
  it('enumerate simulator-vs-prod divergences (findings)', () => {
    const found: string[] = [];
    for (const scenario of ALL_RULES_RTDB_SCENARIOS) {
      for (const tc of scenario.cases) {
        if (tc.pendingCapture) continue;
        const key = `${scenario.id} :: ${tc.description}`;
        const sim = simulatorVerdict(scenario, tc);
        if (sim !== tc.expectation) found.push(`${key} — prod ${tc.expectation}, sim ${sim}`);
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
