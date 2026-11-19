import { row } from './section.ts';

export default row({
  order: 210,
  featureKeys: [],
  behavior: "`.validate` does not run for a node whose new value is null: deleting a node, writing `{}` to it, or deleting the only child of a node whose `.validate` requires children is allowed, while a write that leaves the node non-null still runs its `.validate`",
  evidence: "`oracle:rules-rtdb-r21-validate-on-delete` records production ALLOWING a write of `{}` and a write of `null` to a node whose `.validate` requires `reqA` and `reqB`, the deletion of a parent's only child under `newData.hasChildren()`, and the deletion of one of two children; and DENYING the deletion of `reqB` alone and a write of the node without `reqB`. The simulator matches all 6 cases: an object with no children reads as null.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts rules-denial behavior"],
  oracleObservations: ["rules-rtdb-r21-validate-on-delete"],
  constructs: ["rtdb.rule-kind.validate", "rtdb.semantic.validate-non-cascade"],
});
