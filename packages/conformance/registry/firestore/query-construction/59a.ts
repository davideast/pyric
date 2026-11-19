import { row } from './section.ts';

export default row({
  order: 80,
  rowNumber: 59,
  featureKeys: ["and","orderBy"],
  status: "conforms",
  automation: "oracle-backed",
  behavior: "**Canonical type-order comparison (FS-B3)** -- orderBy + range filters compare by Firestore's canonical type order (`null < bool < number < timestamp < string < bytes < ref < geopoint < array < map`), then within-type; numbers sort numerically, NaN sorts as the smallest number, and range filters (`<`/`<=`/`>`/`>=`) only match same-type values.",
  evidence: "`unit:firestore/sandbox/query-value-order.test.ts`, `oracle:firestore-orderby-canonical-type-order`",
  oracleObservations: ["firestore-orderby-canonical-type-order"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox/query-value-order.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-query-construction.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-query-construction.test.ts"],
});
