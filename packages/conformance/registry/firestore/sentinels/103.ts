import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["deleteField"],
  behavior: "`deleteField()` removes a field on update — the field is fully absent from the returned data, not merely undefined-valued. Legal at the top level or via a **dot-path** (`{'a.b': deleteField()}` removes the nested leaf — FS-B5). **Nested inside a map literal (`{a: {b: deleteField()}}`) it throws `invalid-argument` (FS-B13)** instead of destroying the sibling map.",
  evidence: "`playground:firestore-sentinels` (bundled) + `playground:firestore-row-103-deletefield-removes-field` (one-claim), oracle: `packages/conformance/observations/firestore/firestore-row-103-deletefield-removes-field.json` — `setDoc({keep:1, remove:2})` then `updateDoc({remove: deleteField()})` yields a doc whose `data()` has keys `['keep']` only, `keep === 1` preserved; `unit:admin-compat/nested-delete-field.test.ts` (nested → invalid-argument; dot-path + top-level still valid; verified failing pre-fix)",
  risk: ["specific-value","error-code","specific-field","sentinel"],
  riskScore: 8,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `invalid-argument`","asserts a specific field/property value","asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-row-103-deletefield-removes-field"],
  conformanceTests: ["packages/pyric/test/sandbox/firestore/admin-compat/nested-delete-field.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
