import { row } from './section.ts';

export default row({
  order: 90,
  behavior: "`CollectionReference.withConverter(c)` is an instance method on `collection()` and `collectionGroup()` values; the converter reaches `doc(typedColl, id)`, `doc(typedColl)`, `query()`, `addDoc`, `getDocs`, and `onSnapshot`",
  evidence: "`unit:collection-converter-method.test.ts`, `oracle:firestore-withconverter-collection-method-propagation`",
  oracleObservations: ["firestore-withconverter-collection-method-propagation"],
  conformanceTests: ["packages/pyric/test/firestore/collection-converter-method.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-withconverter.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-withconverter.test.ts"],
});
