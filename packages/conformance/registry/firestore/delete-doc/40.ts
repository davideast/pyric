import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Rules-denied delete throws `permission-denied`",
  evidence: "`unit:sandbox-target.test.ts` (rules-reject branch), oracle: `packages/conformance/observations/firestore/firestore-delete-denied-error-code.json` (prod `deleteDoc` on a denied path throws a `FirebaseError` with `.code === 'permission-denied'`, `.message === '7 PERMISSION_DENIED: Missing or insufficient permissions.'`, `instanceof Error`)",
  risk: ["specific-value","error-code","specific-field","rules-denial"],
  riskScore: 8,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `permission-denied`","asserts a specific field/property value","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-delete-denied-error-code"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts"],
});
