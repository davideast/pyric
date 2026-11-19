import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "`snap.val()` returns `null` for a missing path (NOT a thrown error — RTDB diverges from Firestore here; `getDoc` returns `exists()===false` but `get` on RTDB just returns a `null`-val snapshot)",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-get-missing-path.json` — observed `threw: false, val: null, exists: false` on a never-written path against digame-mas. The root of an empty database is the same case: the production SDK computes `DataSnapshot.exists()` as `!node.isEmpty()` at every path, the root included. The in-page sandbox, the served worker host and the Node host each read an empty root as `val: null, exists: false`, before any write and after the last child is removed.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  oracleObservations: ["rtdb-modular-get-missing-path"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts", "packages/cli/test/serve/worker/rtdb-empty-root.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
  aliases: ["rtdb#107"],
});
