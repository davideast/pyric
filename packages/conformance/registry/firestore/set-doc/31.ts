import { row } from './section.ts';

export default row({
  order: 60,
  automation: "oracle-backed",
  behavior: "Converter (via `withConverter`) runs `toFirestore` before the write (1 arg on full/`merge: false` writes, forwarding `SetOptions` as arg 2 on `merge: true` or `mergeFields` writes)",
  evidence: "`unit:sandbox-target.test.ts` (\"withConverter on a DocumentReference round-trips\"), `oracle:firestore-setdoc-converter-options-forwarding`",
  oracleObservations: ["firestore-setdoc-converter-options-forwarding"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-setdoc.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-setdoc.test.ts"],
});
