import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Original untyped ref keeps its identity after `withConverter(ref, c)` (two views, one path)",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-withconverter-preserves-untyped-ref-identity`",
  oracleObservations: ["firestore-withconverter-preserves-untyped-ref-identity"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
