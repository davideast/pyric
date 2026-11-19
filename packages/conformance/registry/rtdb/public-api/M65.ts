import { row } from './section.ts';

export default row({
  order: 740,
  featureKeys: ["ref","child"],
  behavior: "Write-boundary normalization (`nodeFromJSON`-equivalent): a value written as an array is stored as an integer-keyed object — `child(ref, '1')` returns the element, `forEach` iterates `0,1,2…` (DB-B2)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/normalization.test.ts` (\"array write is addressable by integer-string child key\" + \"forEach over an array iterates its elements\"); matches oracle `rtdb-modular-array-write-normalization.json` (local + SharedWorker + Node host replay); upstream `core/snap/nodeFromJSON.ts:118-128`, `core/snap/ChildrenNode.ts:194-230`",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-array-write-normalization"],
  conformanceTests: ["packages/pyric/test/database/modular/normalization.test.ts","packages/pyric/test/database/cdd/capture-normalization-and-validation.test.ts","packages/cli/test/serve/worker/oracle-captures/rtdb-normalization-and-validation.test.ts"],
  rowNumber: 65,
});
