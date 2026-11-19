import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Tri-state error semantics: field access of a missing key, by dot (`resource.data.typo`) or by index (`resource.data['typo']`, `resource.data[field]`), a list index out of bounds, access on null/undefined, undefined variables, and `get()`-of-missing ERROR → deny; `&&`/`||` absorb operand errors **commutatively** (CEL: `error || true` → true, `error && false` → false). A key present with a null value reads null. Use `key in map` or `map.get(key, default)` for a may-be-absent key. (RULES-B2/B3/B8)",
  status: "conforms",
  evidence: "`unit:rules/simulator/evaluator.test.ts` (RULES-B2 / RULES-B3 / RULES-B8 blocks) covers dotted and index access, null access, undefined variables, `get()` of a missing document and error absorption. Production capture, 2026-09-28: `oracle:rules-firestore-undefined-field-access` records production denying index access of a missing key on `resource.data`, `request.resource.data` and `request.auth.token` under `==`, `!=`, `== null`, `!`, `is`, `in`, `.size()`, a nested map, a computed key, a path variable key and a `let` that is used; allowing under `|| true`, `!(... && false)`, an unused `let`, an `in` guard, a key present with null and `get(key, null)`; and denying a list index past either end and a string key on a list. The simulator returned null for a missing index key and allowed 16 of those denials; it now reads index access through `rules/simulator/index-access.ts`, shared with the Storage evaluator, and matches production on all 41 cases (replayed by `unit:rules/oracle-conformance.test.ts`; `unit:rules/index-access.test.ts` runs each shape through both engines).",
  automation: "unit-backed",
  conformanceTests: [
    "packages/rules/test/simulator/evaluator.test.ts",
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/index-access.test.ts",
  ],
});
