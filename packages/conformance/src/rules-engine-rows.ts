/**
 * The ONE definition of "this rules-language construct is PRODUCTION-VERIFIED",
 * and the ONE index of what the rules-engine registry rows say about each
 * construct.
 *
 * Two consumers ask that question and must not answer it differently:
 *
 *   - `rules-language-analyzer.ts` — the coverage report's `verifiedConstructs`
 *     numerator: the published rules-language verified-coverage number.
 *   - `assurance-capabilities.ts` — the `supported` verdict a capability's
 *     construct dependency needs before an assurance probe may report a security
 *     conclusion instead of abstaining.
 *
 * While they each had their own answer, a construct could be counted verified in
 * one number and known-wrong in the other, with nothing to say which was right.
 *
 * ── THE EVIDENCE, POSITIVE AND NEGATIVE ──────────────────────────────────
 *
 * POSITIVE — SYNTACTIC. A production-captured corpus scenario (one with an
 * observation twin) whose ruleset AST contains the construct. The analyzer finds
 * the node in the source; the twin holds production's verdicts on that source.
 *
 * POSITIVE — BEHAVIORAL. A `conforms` + `oracle-backed` RULES-ENGINE row whose
 * `constructs` scope lists the construct: that row's verdicts were captured from
 * production and replayed verdict-for-verdict against the simulator.
 *
 * NEGATIVE — CONTAMINATION. A `diverged-documented` or `bug` RULES-ENGINE row
 * whose `constructs` scope lists the construct. Such a row is a standing,
 * committed statement that the simulator is KNOWN WRONG about that construct.
 *
 * ── NEGATIVE EVIDENCE DOMINATES POSITIVE ─────────────────────────────────
 *
 * A construct the engine is known wrong about can never be green — not even when
 * a captured scenario also exercises it, and not even when another conforming
 * row also scopes it. The two kinds of evidence are not weighed against each
 * other and do not cancel out:
 *
 *   A `conforms` row says "in the cases we captured, the simulator matched."
 *   A `diverged-documented` row says "there are cases where it does not."
 *
 * The first is a statement about a sample; the second is a statement about the
 * construct. Letting the sample outvote the counterexample is how a language
 * construct with a KNOWN, DOCUMENTED divergence gets published as
 * production-verified — the exact fake this predicate exists to make impossible.
 * The assurance generator already applied this rule to capability status; the
 * coverage numerator now applies the same one, from this module, so the two
 * cannot disagree.
 *
 * The cost is borne deliberately: contamination is SCOPED, so a divergence
 * declaring a wide `constructs` scope pulls every construct in it out of the
 * verified count. That number going DOWN when a divergence is found is the
 * mechanism working. Narrowing it is done by narrowing the divergence — fixing
 * the engine — never by narrowing the annotation to protect the number.
 */
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from '../registry/types.ts';

/**
 * The registry surfaces that ARE a rules engine (as opposed to an SDK that
 * enforces an engine's verdict). Only these rows speak about the machinery that
 * decides ALLOW/DENY, so only these rows can prove — or contaminate — a language
 * construct. A `diverged-documented` row on `firestore` (the SDK) says the
 * client library differs somewhere; it says nothing about the rules language.
 */
export const RULES_ENGINE_SURFACES: ReadonlySet<string> = new Set([
  'firestore-rules',
  'storage-rules',
  'rtdb-rules',
]);

/** What the rules-engine rows say about each construct, split by what they say. */
export interface ConstructScopeIndex {
  /** construct id -> ids of `conforms` + `oracle-backed` rules-engine rows whose
   *  `constructs` scope lists it (the BEHAVIORAL positive path). */
  provingRows: Map<string, string[]>;
  /** construct id -> ids of `diverged-documented` / `bug` rules-engine rows whose
   *  `constructs` scope lists it: the simulator is known wrong about it. */
  divergingRows: Map<string, string[]>;
}

/** Index every registry row's `constructs` scope. */
export function indexConstructScopes(
  registries: readonly CompatibilitySurfaceRegistry[],
): ConstructScopeIndex {
  const provingRows = new Map<string, string[]>();
  const divergingRows = new Map<string, string[]>();
  for (const registry of registries) {
    for (const block of registry.blocks) {
      if (block.kind !== 'table') continue;
      for (const row of block.rows) addRow(row, provingRows, divergingRows);
    }
  }
  return { provingRows, divergingRows };
}

function addRow(
  row: CompatibilityRow,
  provingRows: Map<string, string[]>,
  divergingRows: Map<string, string[]>,
): void {
  if (!RULES_ENGINE_SURFACES.has(row.surface)) return;
  const contaminating = row.status === 'diverged-documented' || row.status === 'bug';
  const proving = row.status === 'conforms' && row.automation === 'oracle-backed';
  const target = contaminating ? divergingRows : proving ? provingRows : undefined;
  if (!target) return;
  for (const construct of row.constructs ?? []) {
    target.set(construct, [...(target.get(construct) ?? []), row.id]);
  }
}

/** Everything the graph knows about one construct's comparison against production. */
export interface ProductionEvidence {
  /** POSITIVE, syntactic: production-captured scenarios whose AST contains it. */
  scenarios: readonly string[];
  /** POSITIVE, behavioral: conforming, oracle-backed rules-engine rows scoping it. */
  provingRows: readonly string[];
  /** NEGATIVE: diverged/bug rules-engine rows scoping it. Any entry here vetoes. */
  divergingRows: readonly string[];
}

/** Read one construct's evidence out of the index. */
export function productionEvidenceFor(
  id: string,
  index: ConstructScopeIndex,
  scenarios: readonly string[],
): ProductionEvidence {
  return {
    scenarios,
    provingRows: index.provingRows.get(id) ?? [],
    divergingRows: index.divergingRows.get(id) ?? [],
  };
}

/**
 * THE PREDICATE. A construct is production-verified when some evidence path
 * positively backs it AND no rules-engine divergence covers it.
 *
 * Support is positive (absence of evidence is not verification, so silence can
 * never produce a claim) and contamination is absolute (a single divergence
 * scoping the construct vetoes every amount of positive evidence).
 */
export function isProductionVerified(evidence: ProductionEvidence): boolean {
  if (evidence.divergingRows.length > 0) return false;
  return evidence.scenarios.length > 0 || evidence.provingRows.length > 0;
}

/** The one wording for the evidence, so every consumer cites it identically. */
export function describeProductionEvidence(evidence: ProductionEvidence): string[] {
  const contaminated = evidence.divergingRows.length > 0;
  const lines: string[] = [];

  // When a divergence covers the construct the positive evidence is still
  // REPORTED — the reader should see exactly what was found and why it did not
  // earn credit — but it is never described as verification.
  if (evidence.scenarios.length > 0) {
    lines.push(
      contaminated
        ? `${evidence.scenarios.length} captured scenario(s) exercise it`
        : `production-verified by ${evidence.scenarios.length} captured scenario(s)`,
    );
  } else if (evidence.provingRows.length > 0) {
    lines.push(
      contaminated
        ? `scoped by conforming oracle-backed rules-engine row ${evidence.provingRows.join(', ')}`
        : `production-verified by conforming oracle-backed rules-engine row ${evidence.provingRows.join(', ')}`,
    );
  } else if (!contaminated) {
    lines.push('no production-captured scenario and no conforming oracle-backed row verifies it');
  }

  if (contaminated) {
    lines.push(
      `NOT production-verified: rules-engine divergence ${evidence.divergingRows.join(', ')} covers this construct — the simulator is known wrong about it, and no quantity of positive evidence outvotes a documented counterexample`,
    );
  }
  return lines;
}
