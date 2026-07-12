/**
 * Production-parity stress test — live Firestore Rules Test API.
 *
 * Resurrected from the pre-cutover suite (deleted in be3c2b2; restored per
 * the design rationale section 5 and round-3 track P3). The 12 scenarios
 * are byte-identical to the originals; only the bootstrap changed:
 * `initializeAgentApp({ credentialEnvVar })` (died with packages/sdk) →
 * `parityScope()` (firebase-admin cert credential from PARITY_SA_BASE64).
 *
 * The scenario corpus MOVED (conformance-chain consolidation, staging): the 12
 * scenarios now live as one authored record per file under
 * `packages/conformance/rules-corpus/firestore/` (each scenario's `group` field
 * is `'stress'`) and are imported here as `STRESS_SCENARIOS`, computed by the
 * corpus loader. This live-network parity suite is unchanged in behavior —
 * it just sources the migrated corpus instead of holding it inline.
 *
 * Production is the source of truth. For each case we report:
 *   - OK         : sim agrees with prod and prod matches expected
 *   - SIM_BUG    : sim disagrees with prod (prod is right, sim is wrong)
 *   - BAD_RULE   : prod disagrees with expected (the test itself is wrong;
 *                  rewrite the rule before drawing any conclusion)
 *   - ERR        : either side errored at the API layer
 *
 * The test passes if the run completes; the per-scenario tally is the artifact.
 *
 * Requires: PARITY_SA_BASE64 in env — a minimal service account that
 * holds only `firebaserules.rulesets.test` (no need for the broad
 * FIREBASE_SA_BASE64 the live-integration tests use). Skips cleanly
 * when the secret is absent (external PRs, unit-suite CI).
 */
import { describe, test, beforeAll, afterAll } from 'bun:test';
import type { ProjectScope } from 'pyric-tools/deploy';
import {
  type Scenario,
  type CaseRow,
  hasParitySecret,
  parityScope,
  runScenario,
  reportParity,
} from './harness.js';
import { STRESS_SCENARIOS } from '../../../../../packages/conformance/rules-corpus/firestore/index.ts';

const SCENARIOS: Scenario[] = STRESS_SCENARIOS;

// ─── Test ──────────────────────────────────────────────────────────────────

const HAS_SA = hasParitySecret();
let scope: ProjectScope;
const allRows: CaseRow[] = [];

beforeAll(() => {
  if (!HAS_SA) return;
  scope = parityScope();
});

describe.skipIf(!HAS_SA)('production parity stress test', () => {
  for (const scenario of SCENARIOS) {
    test(`scenario: ${scenario.id}`, async () => {
      allRows.push(...await runScenario(scenario, scope));
    }, 60000);
  }
});

afterAll(() => {
  if (!HAS_SA || allRows.length === 0) return;
  reportParity('Production parity stress test report', SCENARIOS, allRows);
});
