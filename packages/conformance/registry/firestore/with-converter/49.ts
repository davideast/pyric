import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "`withConverter(ref, null)` strips the converter, returns the underlying untyped view",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-withconverter-null-strips-converter`",
  oracleObservations: ["firestore-withconverter-null-strips-converter"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
