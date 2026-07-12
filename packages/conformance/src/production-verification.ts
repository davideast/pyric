/**
 * The ONE definition of "this rules-language construct is PRODUCTION-VERIFIED".
 *
 * Two consumers ask that question and must not answer it differently:
 *
 *   - `rules-language-analyzer.ts` — the coverage report's `verifiedConstructs`
 *     numerator (the trust number published in the language-coverage docs);
 *   - `assurance-capabilities.ts` — the `supported` verdict a capability's
 *     construct dependency needs before an assurance probe may report a
 *     security conclusion instead of abstaining.
 *
 * When those two disagreed, a construct could be counted in one number and not
 * the other with no way to tell which was right. There is now one predicate and
 * one construct-scope index; both call them.
 *
 * ── THE TWO EVIDENCE PATHS ───────────────────────────────────────────────
 *
 * Both are a real comparison against production. Neither is an assertion.
 *
 *   SYNTACTIC — a production-captured corpus scenario (one with an observation
 *   twin) whose ruleset AST CONTAINS the construct. The analyzer finds the node
 *   in the source, the twin proves production's verdict on that source was
 *   replayed and matched. This is `ProductionEvidence.scenarios`.
 *
 *   BEHAVIORAL — a `conforms` + `oracle-backed` RULES-ENGINE registry row whose
 *   `constructs` scope lists the construct. That row's verdicts were captured
 *   from production (a Rules Test API call for Firestore/Storage, a
 *   deploy-observe-restore run against the live service for RTDB) and replayed
 *   verdict-for-verdict against the simulator. This is
 *   `ProductionEvidence.provingRows`.
 *
 * The behavioral path exists because the analyzer credits constructs
 * SYNTACTICALLY: it looks for the construct's node in the ruleset source. Some
 * constructs have no node to find, because they are what the ENGINE does with a
 * tree of rules rather than something a ruleset WRITES. The RTDB cascade
 * semantics are the case in point — `rtdb.semantic.read-cascade`,
 * `rtdb.semantic.write-cascade`, `rtdb.semantic.validate-non-cascade` have no
 * token, no key, no expression form. They can only be seen in a VERDICT.
 *
 * ── THE HONESTY LINE: WHAT A BEHAVIORAL ROW MAY AND MAY NOT CREDIT ───────
 *
 * A row may credit a construct only where one of its captured verdicts is a
 * POSITIVE EVENT that no other semantic of the engine explains:
 *
 *   creditable    a cascade GRANT: a read of `/inner/deep` ALLOWs where only an
 *                 ancestor's truthy `.read` can have granted it; a write ALLOWs
 *                 against a child `.write` that evaluated FALSE. Remove the
 *                 cascade and that verdict flips. The ALLOW is the semantic's
 *                 fingerprint.
 *   creditable    a `.validate` VETO: a write DENYs although the `.write` rule
 *                 governing it granted the write. Remove validate's
 *                 non-cascading veto and that verdict flips too.
 *
 *   NOT creditable — `deny-by-default` (`rtdb.semantic.deny-by-default`,
 *   `storage.semantic.deny-by-default`). It is a NON-EVENT: nothing matched, so
 *   nothing happened. Every DENY in every capture is equally explained by "the
 *   rule that governs this path evaluated false" — no single captured verdict
 *   distinguishes the default from an ordinary denial, the way a cascade ALLOW
 *   distinguishes cascade from no-cascade. These two constructs carry
 *   `unattributable` in their snapshot entries, stay OUT of the coverage
 *   denominator, and are not to be behaviorally credited by adding them to a
 *   row's scope. A cascade grant flips a verdict; a default denies where a
 *   denial was already the answer.
 *
 * The row's scope is therefore never "everything the ruleset happens to touch".
 * It is the constructs the row's CAPTURED VERDICTS ADJUDICATE. Under-annotation
 * is safe: a construct nobody's scope lists simply stays unverified, which can
 * only hold a number or a capability DOWN. Over-annotation is a lie in the
 * trust number.
 *
 * ── THE CONTAMINATION RULE: NEGATIVE EVIDENCE DOMINATES POSITIVE ─────────
 *
 * A `diverged-documented` or `bug` RULES-ENGINE row whose `constructs` scope
 * lists a construct is a standing, committed statement that the simulator is
 * KNOWN WRONG about it. Such a construct is NEVER production-verified — not when
 * a captured scenario also exercises it, and not when a conforming row also
 * scopes it. The two kinds of evidence do not weigh against each other:
 *
 *   a `conforms` row says "in the cases we captured, the simulator matched";
 *   a `diverged-documented` row says "there are cases where it does not".
 *
 * The first is a statement about a SAMPLE. The second is a statement about the
 * CONSTRUCT. Letting the sample outvote the counterexample is how a construct
 * with a known, documented divergence gets published as production-verified —
 * and how a capability could reach `supported` on an engine the repo itself
 * records as broken there.
 *
 * The cost is borne deliberately: contamination is SCOPED, so a divergence with
 * a wide `constructs` scope pulls every construct in it out of the verified
 * count. A published number falling when a divergence is found is this rule
 * working. The way to raise it again is to narrow the DIVERGENCE — fix the
 * engine — never to narrow the annotation to protect the number.
 */
import type { CompatibilityRow, CompatibilitySurfaceRegistry } from '../registry/types.ts';

/**
 * The registry surfaces that ARE a rules engine (as opposed to an SDK that
 * enforces an engine's verdict). Only these rows speak about the machinery that
 * decides ALLOW/DENY, so only these rows can prove — or contaminate — a
 * language construct.
 */
export const RULES_ENGINE_SURFACES: ReadonlySet<string> = new Set([
  'firestore-rules',
  'storage-rules',
  'rtdb-rules',
]);

/** The rules-engine rows that speak about each construct, split by what they say. */
export interface ConstructScopeIndex {
  /** construct id -> ids of `conforms` + `oracle-backed` rules-engine rows whose
   *  scope lists it: production compared, production matched (the BEHAVIORAL
   *  verification path). */
  provingRows: Map<string, string[]>;
  /** construct id -> ids of `diverged-documented` / `bug` rules-engine rows whose
   *  scope lists it: the simulator is known wrong about it, so it must not
   *  underwrite a security claim. */
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

/** What the graph knows about one construct's comparison against production. */
export interface ProductionEvidence {
  /** SYNTACTIC: production-captured corpus scenarios whose ruleset AST contains it. */
  scenarios: readonly string[];
  /** BEHAVIORAL: conforming, oracle-backed rules-engine rows whose scope lists it. */
  provingRows: readonly string[];
  /** NEGATIVE: `diverged-documented` / `bug` rules-engine rows whose scope lists
   *  it. The simulator is KNOWN WRONG about the construct. Any entry here vetoes
   *  verification outright — see THE CONTAMINATION RULE above. */
  divergingRows: readonly string[];
}

/** Read one construct's evidence — positive AND negative — out of the index. */
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
 * Support is positive: no evidence is not verification, so the absence of a
 * scenario and the absence of a row can never produce a claim. Contamination is
 * absolute: a single divergence scoping the construct withholds credit however
 * much positive evidence also exists.
 */
export function isProductionVerified(evidence: ProductionEvidence): boolean {
  if (evidence.divergingRows.length > 0) return false;
  return evidence.scenarios.length > 0 || evidence.provingRows.length > 0;
}

/** The one wording for the evidence, so both consumers cite it identically. */
export function describeProductionEvidence(evidence: ProductionEvidence): string {
  const contaminated = evidence.divergingRows.length > 0;
  const withheld = `NOT production-verified: rules-engine divergence ${evidence.divergingRows.join(', ')} covers this construct — the simulator is known wrong about it, and no quantity of positive evidence outvotes a documented counterexample`;

  // When a divergence covers the construct the positive evidence is still
  // REPORTED — a reader should see exactly what was found and why it earned
  // nothing — but it is never described as verification.
  if (evidence.scenarios.length > 0) {
    return contaminated
      ? `${evidence.scenarios.length} captured scenario(s) exercise it; ${withheld}`
      : `production-verified by ${evidence.scenarios.length} captured scenario(s)`;
  }
  if (evidence.provingRows.length > 0) {
    return contaminated
      ? `scoped by conforming oracle-backed rules-engine row ${evidence.provingRows.join(', ')}; ${withheld}`
      : `production-verified by conforming oracle-backed rules-engine row ${evidence.provingRows.join(', ')}`;
  }
  return contaminated ? withheld : 'no production-captured scenario and no conforming oracle-backed row verifies it';
}
