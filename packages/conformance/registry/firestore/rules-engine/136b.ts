import { row } from './section.ts';

export default row({
  order: 110,
  behavior: "`FirestoreSet` VALUE equality: `diff.addedKeys() == [uid].toSet()` compares set contents (order-insensitive); `set == list` is false, not an error (RULES-B13). Pre-fix, ANY two sets compared EQUAL (generic-object deep-equals saw no enumerable keys) — a false-PERMISSIVE divergence found by joining validation",
  status: "conforms",
  evidence: "`unit:rules/simulator/set-equality.test.ts`; live validation: 10/10 both engines",
  automation: "unit-backed",
  conformanceTests: ["packages/rules/test/simulator/set-equality.test.ts"],
  rowNumber: 136,
});
