import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: [],
  behavior: "Snapshot structure and type guards — `hasChild`, `parent()`, `isString`, `isNumber`, `isBoolean`",
  evidence: "NEW ROW, 2026-07-12: production capture proves the simulator resolves the type predicates and the `parent()` path climb as production does, including RTDB's rule that a child `.validate` runs only for children PRESENT in `newData` — the name-without-age write is denied by that field's own parent guard, not by the absent sibling's type rule, which never runs. `oracle:rules-rtdb-r10-snapshot-type-guards` matches production verdict-for-verdict on all 7 cases.",
  oracleObservations: ["rules-rtdb-r10-snapshot-type-guards"],
  constructs: ["rtdb.semantic.validate-non-cascade","rtdb.semantic.read-cascade"],
});
