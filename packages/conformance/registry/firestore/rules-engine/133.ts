import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Tri-state error semantics: field access of a missing key, by dot (`resource.data.typo`) or by index (`resource.data['typo']`, `resource.data[field]`), a list index out of bounds, access on null/undefined, undefined variables, and `get()`-of-missing ERROR -> deny; `&&`/`||` absorb operand errors **commutatively** (CEL: `error || true` -> true, `error && false` -> false). A key present with a null value reads null. Use `key in map` or `map.get(key, default)` for a may-be-absent key. (RULES-B2/B3/B8)",
  status: "conforms",
  evidence: "`unit:rules/simulator/evaluator.test.ts` (RULES-B2 / RULES-B3 / RULES-B8 blocks) covers dotted and index access, null access, undefined variables, `get()` of a missing document and error absorption. Production Rules Test API capture `rules-firestore-undefined-field-access` and client-SDK capture `oracle:firestore-rules-cel-expressions-and-set-equality` verify missing-key error denial, null-valued present keys, `in` / `get(key, fallback)` guards, list OOB denial, and commutative `&&`/`||` error absorption across all planes.",
  automation: "oracle-backed",
  oracleObservations: ["firestore-rules-cel-expressions-and-set-equality"],
  conformanceTests: [
    "packages/rules/test/simulator/evaluator.test.ts",
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/index-access.test.ts",
    "packages/pyric/test/firestore/oracle-captures/firestore-rules-and-query-proof.test.ts",
    "packages/cli/test/serve/worker/oracle-captures/firestore-rules-and-query-proof.test.ts",
  ],
});
