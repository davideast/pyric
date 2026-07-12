/**
 * Live-parity scenarios for the round-1/2 fix classes (round-3 track P3).
 *
 * The resurrected stress scenarios (`parity-stress.test.ts`) predate the
 * remediation rounds, so they would come back green even if the round-1/2
 * fix classes regressed. One focused scenario per fixed ledger class:
 *
 *   - RULES-B3  error-absorption in && / || (CEL commutative tri-state)
 *   - RULES-B2  undefined-field access is a runtime error (not null)
 *   - RULES-B5  int/float distinction + integer division + div-by-zero
 *   - RULES-B4  matches() is a full-string RE2 match (not JS partial)
 *   - RULES-B7  no prototype-chain key leakage (own keys only)
 *   - RULES-B8  get() of a missing doc errors; get() resource has id/__name__
 *
 * The scenario corpus MOVED (conformance-chain consolidation, staging): the 6
 * scenarios now live as one authored record per file under
 * `packages/conformance/rules-corpus/firestore/` (each scenario's `group` field
 * is `'fix-class'`) and are imported here as `FIX_CLASS_SCENARIOS`, computed by
 * the corpus loader. This live-network parity suite is unchanged in
 * behavior — it just sources the migrated corpus instead of holding it inline.
 *
 * Per case the assertion is simulator verdict == live Rules-Test-API
 * verdict; the OK/SIM_BUG tally is the artifact (see harness.ts legend).
 * Any SIM_BUG row here is a round-4 ledger candidate — do not "fix" the
 * test, record the row.
 *
 * Requires: PARITY_SA_BASE64 (firebaserules-only SA). Skips cleanly when
 * the secret is absent.
 */
import { describe, test, beforeAll, afterAll } from 'bun:test';
import type { ProjectScope } from '@pyric/cli/deploy';
import {
  type Scenario,
  type CaseRow,
  hasParitySecret,
  parityScope,
  runScenario,
  reportParity,
} from './harness.js';
import { FIX_CLASS_SCENARIOS } from '../../../../../packages/conformance/rules-corpus/firestore/index.ts';

const SCENARIOS: Scenario[] = FIX_CLASS_SCENARIOS;

// ─── Test ──────────────────────────────────────────────────────────────────

const HAS_SA = hasParitySecret();
let scope: ProjectScope;
const allRows: CaseRow[] = [];

beforeAll(() => {
  if (!HAS_SA) return;
  scope = parityScope();
});

describe.skipIf(!HAS_SA)('round-1/2 fix-class live parity', () => {
  for (const scenario of SCENARIOS) {
    test(`scenario: ${scenario.id}`, async () => {
      allRows.push(...await runScenario(scenario, scope));
    }, 60000);
  }
});

afterAll(() => {
  if (!HAS_SA || allRows.length === 0) return;
  reportParity('Round-1/2 fix-class parity report', SCENARIOS, allRows);
});
