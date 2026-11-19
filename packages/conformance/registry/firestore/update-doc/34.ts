import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Throws `not-found` (sandbox) / `FirebaseError('not-found')` (prod) on missing doc",
  evidence: "`unit:sandbox-target.test.ts` (implicit in writes-fail-on-missing tests), oracle: `packages/conformance/observations/firestore/firestore-updatedoc-missing-error.json` (prod throws `FirebaseError` with `code: 'not-found'`, message `\"5 NOT_FOUND: No document to update: …\"`)",
  risk: ["specific-value","error-code","specific-field"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `not-found`","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-updatedoc-missing-error"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
