import { row } from './section.ts';

export default row({
  order: 810,
  featureKeys: ["query"],
  behavior: "Object-valued children are ORDER-EQUAL — the sort/range tie is broken by key (`nameCompare`), NOT by an invented `JSON.stringify` ordering; a query re-write that only reorders object keys is \"no change\" and doesn't re-fire (DB-B11)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/object-order-equality.test.ts`; matches oracle `rtdb-modular-query-primitive-leaf-and-object-ties.json` (local + SharedWorker + Node host replay); upstream `core/snap/ChildrenNode.ts:386-400`",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-query-primitive-leaf-and-object-ties"],
  conformanceTests: ["packages/pyric/test/database/modular/object-order-equality.test.ts","packages/pyric/test/database/cdd/capture-query-semantics.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-query-semantics.test.ts"],
  rowNumber: 72,
});
