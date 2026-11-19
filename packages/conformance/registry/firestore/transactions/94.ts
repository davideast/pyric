import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Throws `FirebaseError('permission-denied')` on rule denial inside the transaction (the inner write's denial — not a generic `aborted`). Sandbox throws `FirestoreCompatError` with the same `code: 'permission-denied'`",
  status: "conforms",
  evidence: "`unit:sandbox-target.test.ts` (writes-reject branch), oracle: `packages/conformance/observations/firestore/firestore-transaction-rules-denied-error.json` (prod throws `FirebaseError` with `code: 'permission-denied'`, NOT `aborted`; the inner callback ran once and the rules-rejected write surfaces as a regular permission-denied at commit)",
  risk: ["error-code","specific-field","atomicity","rules-denial"],
  riskScore: 8,
  riskReasons: ["asserts Firebase error code(s): `aborted`, `aborted`","asserts a specific field/property value","asserts transaction/batch atomicity","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-transaction-rules-denied-error"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
