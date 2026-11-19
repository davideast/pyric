import { row } from './section.ts';

export default row({
  order: 100,
  behavior: "`Query.withConverter(c)` is an instance method on `query()` values; `withConverter(null)` on a collection or query removes the converter, and `collection(typedDocRef, id)` stays untyped",
  evidence: "`unit:collection-converter-method.test.ts`, `oracle:firestore-withconverter-query-method-and-subcollection-isolation`",
  oracleObservations: ["firestore-withconverter-query-method-and-subcollection-isolation"],
  conformanceTests: ["packages/pyric/test/firestore/collection-converter-method.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
