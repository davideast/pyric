import { row } from './section.ts';

export default row({
  order: 40,
  rowNumber: 81,
  automation: "oracle-backed",
  oracleObservations: ["firestore-onsnapshot-filtered-timestamp-and-refs"],
  behavior: "**Listener `.data()` matches `getDoc` shape (FS-B10)** -- the `onSnapshot` doc + query snapshot path runs the same read-path translation as `getDoc`/`getDocs`, so `snap.data().createdAt` is a compat `Timestamp` (`{seconds, nanoseconds}`), not the rules-internal wrapper (`{seconds, nanos}` + `typeName`, no `nanoseconds`). Pre-FS-B10 a listener leaked the internal shape while the single-doc read returned the compat shape.",
  evidence: "`unit:simulator/listener-read-translation.test.ts`, `oracle:firestore-onsnapshot-filtered-timestamp-and-refs` (`docIsTimestamp: true`, `docEqualsGetDoc: true`, `queryIsTimestamp: true`, `queryEqualsGetDoc: true`)",
  risk: ["listener"],
  riskScore: 2,
  riskReasons: ["asserts listener semantics"],
  conformanceTests: ["packages/pyric/test/sandbox/firestore/simulator/listener-read-translation.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-crud-cursors-listeners.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-crud-cursors-listeners.test.ts"],
});
