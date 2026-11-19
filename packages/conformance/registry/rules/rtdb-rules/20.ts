import { row } from './section.ts';

export default row({
  order: 200,
  featureKeys: ["getPriority"],
  behavior: "`getPriority()` returns a node's number or string priority, on the node or through `child()`, and `val()` returns the node's value rather than its `{ .value, .priority }` form, for stored data and for a write that carries a priority",
  evidence: "`oracle:rules-rtdb-r20-priority-values` records production ALLOWING all 8 cases: seeded number and string priorities read back through `getPriority()`, the value of a prioritized node and of a prioritized child read through `val()`, a plain node reads a null priority, and a write of `{ '.value': 'w', '.priority': 7 }` passes `newData.getPriority() == 7 && newData.val() == 'w'`. The simulator matches all 8 cases: `getPriority()` reads a node's `.priority`, and `val()` reads `.value` and drops `.priority` at every level. The sandbox matches all 8 too (`unit:rules/rtdb/argument-and-operand-sandbox.test.ts` replays the capture): it stores the priority of every node a written or seeded value carries, a nested `{ '.value', '.priority' }` included, and rules read stored priorities through `data`, `root` and `newData`.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 2 specific value(s)"],
  oracleObservations: ["rules-rtdb-r20-priority-values"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/pyric/test/rules/rtdb/argument-and-operand-sandbox.test.ts"],
  constructs: ["rtdb.method.snapshot.getPriority", "rtdb.method.snapshot.val"],
});
