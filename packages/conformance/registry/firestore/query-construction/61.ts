import { row } from './section.ts';

export default row({
  order: 120,
  featureKeys: ["limitToLast"],
  behavior: "`limitToLast(n)` returns the trailing n documents in an ordered result; without `orderBy`, it throws a `FirestoreError` with production's `unimplemented` code",
  status: "conforms",
  evidence: "Oracle-locked by `packages/conformance/observations/firestore/firestore-limittolast-preconditions.json`: production's no-orderBy precondition throws code `unimplemented`, while ordered trailing-window semantics return `[\"b\"]`. `oracle:firestore#61` replays both claims. Cursor composition + descending: `unit:upstream-query-probes.test.ts`; cursor/empty-snapshot preconditions: `unit:sandbox-target.test.ts` + `unit:admin-compat/cursors.test.ts`.",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 2 specific value(s)","asserts Firebase error code: `unimplemented`"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-limittolast-preconditions"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts","packages/pyric/test/sandbox/firestore/admin-compat/cursors.test.ts","packages/pyric/test/firestore/oracle-conformance.test.ts","packages/pyric/test/firestore/upstream-query-probes.test.ts"],
  conformanceChecks: [{"finding":"FS-61","observation":"firestore-limittolast-preconditions","expect":{"noOrderByThrew":true,"code":"unimplemented","trailingIds":["b"]},"probe":"packages/pyric/test/firestore/oracle-conformance.test.ts","guards":"limitToLast preserves the production trailing window and no-orderBy error code."}],
});
