import { row } from './section.ts';

export default row({
  order: 750,
  featureKeys: ["get"],
  behavior: "Read-side array coercion: a dense integer-keyed object renders back as an array on `snap.val()` (`allIntegerKeys && maxKey < 2 * numKeys`), with a hole at each missing index; `exportVal()` and `toJSON()` keep it an object (DB-B2, RT-6)",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/normalization.test.ts` (\"a dense integer-keyed object reads back as an array\") and `unit:modular/snapshot-serialization.test.ts` (holes, export shape, #1371); matches oracle `rtdb-modular-sparse-integer-array-coercion.json` (local + SharedWorker + Node host replay) and `packages/cli/test/serve/worker/client/rtdb-sparse-array-holes.test.ts`; upstream `core/snap/ChildrenNode.ts:196-230`",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-sparse-integer-array-coercion"],
  conformanceTests: ["packages/pyric/test/database/modular/normalization.test.ts", "packages/pyric/test/database/modular/snapshot-serialization.test.ts", "packages/cli/test/serve/worker/client/rtdb-sparse-array-holes.test.ts", "packages/pyric/test/database/cdd/capture-normalization-and-validation.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-normalization-and-validation.test.ts"],
  rowNumber: 66,
});
