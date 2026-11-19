import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Merges `data` into the existing doc; missing fields preserved. **Top-level keys are dot-separated FieldPaths** (FS-B5): `updateDoc({'a.b': 2})` sets the nested leaf `a.b` (preserving `a.c`), not a literal `\"a.b\"` key; a single-segment map value replaces that field wholesale; `deleteField()` at a dotted path removes the nested leaf.",
  evidence: "`unit:sandbox-target.test.ts`, `unit:admin-compat/field-path-merge.test.ts` (FS-B5 dot-path nested write + delete; verified failing pre-fix)",
  risk: ["sentinel"],
  riskScore: 2,
  riskReasons: ["asserts sentinel or atomic transform semantics"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-updatedoc-dotpath-fieldpath"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/sandbox/firestore/admin-compat/field-path-merge.test.ts"],
});
