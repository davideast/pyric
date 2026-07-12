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
}

/**
 * THE PREDICATE. A construct is production-verified when at least one evidence
 * path backs it. Support is positive: no evidence is not verification, so the
 * absence of a scenario and the absence of a row can never produce a claim.
 */
export function isProductionVerified(evidence: ProductionEvidence): boolean {
  return evidence.scenarios.length > 0 || evidence.provingRows.length > 0;
}

/** The one wording for the evidence, so both consumers cite it identically. */
export function describeProductionEvidence(evidence: ProductionEvidence): string {
  if (evidence.scenarios.length > 0) {
    return `production-verified by ${evidence.scenarios.length} captured scenario(s)`;
  }
  if (evidence.provingRows.length > 0) {
    return `production-verified by conforming oracle-backed rules-engine row ${evidence.provingRows.join(', ')}`;
  }
  return 'no production-captured scenario and no conforming oracle-backed row verifies it';
}
