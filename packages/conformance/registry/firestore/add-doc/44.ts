import { row } from './section.ts';

export default row({
  order: 40,
  status: "conforms",
  automation: "oracle-backed",
  oracleObservations: ["firestore-crud-converter-delete-and-adddoc"],
  behavior: "Converter on the parent collection propagates onto the returned ref",
  evidence: "`unit:sandbox-target.test.ts`, `oracle:firestore-crud-converter-delete-and-adddoc` (`converterPropagated: true`, `toCallsAfterAddDoc: 1`, `initialTypedData: { label: 'ALPHA', count: 1 }`)",
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
