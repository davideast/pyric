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

/**
 * Which historical aggregate a pack came from: the resurrected pre-cutover
 * suite (`stress`, formerly stress-packs.ts) or a round-1/2 remediation
 * (`fix-class`, formerly fix-class-packs.ts). The live-parity suites
 * (packages/pyric/test/rules/parity/parity-stress.test.ts and
 * round-fix-classes.test.ts) run these as two separate reports, so the
 * distinction is authored per pack rather than inferred.
 */
export type PackGroup = 'stress' | 'fix-class';

/**
 * The authored shape for one file in rules-corpus/firestore/. The filename
 * IS the pack id, so the record carries no `id` field — the loader
 * (./load.ts) injects it from the filename. `group` is loader-only
 * classification metadata: it is consumed to reconstruct STRESS_PACKS /
 * FIX_CLASS_PACKS and is stripped before a `Pack` reaches any other
 * consumer, so the `Pack` type itself (and everything that already reads
 * it — the capture runner, the replay suite, the live parity harness)
 * stays unchanged.
 */
export type PackRecord = Omit<Pack, 'id'> & { group: PackGroup };

export type { TestCase };
