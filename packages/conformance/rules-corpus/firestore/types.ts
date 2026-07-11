/**
 * Shared corpus types for the Firestore rules conformance chain.
 *
 * This is the SINGLE source for the `Pack` shape. Both consumers import it
 * from here:
 *   - the live parity harness (packages/pyric/test/rules/parity/harness.ts,
 *     which re-exports `Pack` so its existing importers keep working), and
 *   - the capture runner (scripts/oracle/run-rules.ts) + the replay suite
 *     (packages/pyric/test/rules/oracle-conformance.test.ts).
 *
 * A `Pack` is a self-contained rules-conformance unit: one ruleset plus the
 * cases that exercise it. The `fm` ledger tag and one-line `rationale` are
 * carried through from the pre-cutover parity suite so the provenance of each
 * pack survives the move into the corpus. `TestCase` is imported from the
 * production rules spec (the same type the Test API client consumes), so a
 * pack can be handed straight to either the simulator or the production
 * Rules Test API without a translation layer.
 */
import type { TestCase } from '../../../../packages/pyric/src/rules/test/spec.ts';

export interface Pack {
  /** Stable identifier. Doubles as the observation filename stem:
   *  `rules-firestore-<id>.json`. Must be unique across the corpus. */
  id: string;
  /** Failure-mode / ledger tag (e.g. 'FM3', 'RULES-B3', 'Item 5.1'). */
  fm: string;
  /** One line: why this pack should reveal something. */
  rationale: string;
  /** The ruleset under test. */
  rules: string;
  /** The cases to run against `rules`. Each case's `description` is unique
   *  within the pack and is used as the verdict-table key in observations. */
  cases: TestCase[];
}

export type { TestCase };
