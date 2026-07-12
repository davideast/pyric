/**
 * The rules-engine registry rows, indexed by the language constructs they SCOPE.
 *
 * A rules-engine surface is one whose rows adjudicate the machinery that decides
 * ALLOW/DENY — the simulators themselves — as opposed to an SDK surface that
 * merely enforces a verdict handed to it. Such a row may declare a `constructs`
 * scope (registry/types.ts `CompatibilityRow.constructs`): the language-construct
 * ids whose behavior that row's captured verdicts adjudicate.
 *
 * That scope means one of two things, decided by the row's status, and BOTH
 * consumers of the conformance graph — the coverage analyzer
 * (rules-language-analyzer.ts) and the assurance capability derivation
 * (assurance-capabilities.ts) — must read it the SAME way, which is why the
 * predicate lives here once rather than in each of them:
 *
 *   PRODUCTION-VERIFIED  `conforms` + `oracle-backed`: the row's verdicts were
 *     captured from production and replayed against the simulator, and they
 *     matched. This is the SECOND production-verification path, and the only one
 *     open to a `semantic` construct: the coverage analyzer attributes constructs
 *     SYNTACTICALLY, by walking a ruleset's AST for the tokens it contains, so a
 *     semantic that is not a token — RTDB's read/write cascade, the deny-by-
 *     default floor, Firestore's error absorption — can never be credited by the
 *     token walk no matter how thoroughly production proves it. The row that
 *     proves it says so.
 *
 *   CONTAMINATED  `diverged-documented` / `bug`: the simulator is KNOWN WRONG
 *     about the construct, so it must not underwrite a security claim. The
 *     assurance derivation downgrades every capability depending on it. Note
 *     this does NOT withdraw coverage credit: coverage answers "was this checked
 *     against production", and a divergence is a check — it is the assurance
 *     layer's job to refuse the trust, not the coverage layer's to hide the
 *     evidence.
 *
 * An UNANNOTATED row supplies no verification, so a missing `constructs` scope
 * can only hold a construct DOWN, never lift it.
 */
import { surfaceRegistries, type CompatibilityRow } from '../registry/index.ts';

/**
 * The registry surfaces that ARE a rules engine. A divergence here is a
 * divergence in the machinery that decides ALLOW/DENY itself.
 */
export const RULES_ENGINE_SURFACES = new Set(['firestore-rules', 'storage-rules', 'rtdb-rules']);

/** Every registry row, by id. */
export function allRegistryRows(): Map<string, CompatibilityRow> {
  const rows = new Map<string, CompatibilityRow>();
  for (const registry of surfaceRegistries) {
    for (const block of registry.blocks) {
      if (block.kind !== 'table') continue;
      for (const row of block.rows) rows.set(row.id, row);
    }
  }
  return rows;
}

export interface RulesEngineRowIndex {
  /** construct id -> ids of conforming, oracle-backed rules-engine rows whose
   *  captured production verdicts prove it (the production-verified path). */
  provedBy: Map<string, string[]>;
  /** construct id -> ids of diverged/bug rules-engine rows that cover it (the
   *  simulator is known wrong about the construct). */
  divergedBy: Map<string, string[]>;
}

/** Index every rules-engine row by the constructs its `constructs` scope names. */
export function indexRulesEngineRows(rows: Iterable<CompatibilityRow>): RulesEngineRowIndex {
  const provedBy = new Map<string, string[]>();
  const divergedBy = new Map<string, string[]>();
  for (const row of rows) {
    if (!RULES_ENGINE_SURFACES.has(row.surface)) continue;
    const contaminating = row.status === 'diverged-documented' || row.status === 'bug';
    const proving = row.status === 'conforms' && row.automation === 'oracle-backed';
    const target = contaminating ? divergedBy : proving ? provedBy : undefined;
    if (!target) continue;
    for (const construct of row.constructs ?? []) {
      target.set(construct, [...(target.get(construct) ?? []), row.id]);
    }
  }
  return { provedBy, divergedBy };
}

/** {@link indexRulesEngineRows} over every registry. */
export function rulesEngineRowIndex(): RulesEngineRowIndex {
  return indexRulesEngineRows(allRegistryRows().values());
}
