/**
 * Shared corpus types for the Firestore rules conformance chain.
 *
 * This is the SINGLE source for the `Scenario` shape. Both consumers import it
 * from here:
 *   - the live parity harness (packages/pyric/test/rules/parity/harness.ts,
 *     which re-exports `Scenario` so its existing importers keep working), and
 *   - the capture runner (packages/conformance/src/run-rules.ts) + the replay suite
 *     (packages/pyric/test/rules/oracle-conformance.test.ts).
 *
 * A `Scenario` is a self-contained rules-conformance unit: one ruleset plus the
 * cases that exercise it. The `fm` ledger tag and one-line `rationale` are
 * carried through from the pre-cutover parity suite so the provenance of each
 * scenario survives the move into the corpus. `TestCase` is imported from the
 * production rules spec (the same type the Test API client consumes), so a
 * scenario can be handed straight to either the simulator or the production
 * Rules Test API without a translation layer.
 */
import type { TestCase } from '../../../../packages/pyric/src/rules/test/spec.ts';

export interface Scenario {
  /** Stable identifier. Doubles as the observation filename stem:
   *  `rules-firestore-<id>.json`. Must be unique across the corpus. */
  id: string;
  /** Failure-mode / ledger tag (e.g. 'FM3', 'RULES-B3', 'Item 5.1'). */
  fm: string;
  /** One line: why this scenario should reveal something. */
  rationale: string;
  /** The ruleset under test. */
  rules: string;
  /** The cases to run against `rules`. Each case's `description` is unique
   *  within the scenario and is used as the verdict-table key in observations. */
  cases: TestCase[];
}

/**
 * Which historical aggregate a scenario came from: the resurrected pre-cutover
 * suite (`stress`, formerly stress-scenarios.ts) or a round-1/2 remediation
 * (`fix-class`, formerly fix-class-scenarios.ts). The live-parity suites
 * (packages/pyric/test/rules/parity/parity-stress.test.ts and
 * round-fix-classes.test.ts) run these as two separate reports, so the
 * distinction is authored per scenario rather than inferred.
 */
export type ScenarioGroup = 'stress' | 'fix-class';

/**
 * The authored shape for one file in rules-corpus/firestore/. The filename
 * IS the scenario id, so the record carries no `id` field — the loader
 * (./load.ts) injects it from the filename. `group` is loader-only
 * classification metadata: it is consumed to reconstruct STRESS_SCENARIOS /
 * FIX_CLASS_SCENARIOS and is stripped before a `Scenario` reaches any other
 * consumer, so the `Scenario` type itself (and everything that already reads
 * it — the capture runner, the replay suite, the live parity harness)
 * stays unchanged.
 */
export type ScenarioRecord = Omit<Scenario, 'id'> & { group: ScenarioGroup };

export type { TestCase };
