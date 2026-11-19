import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Re-evaluates rules under current user on every call (sandbox-live) — read denied throws `permission-denied`",
  status: "conforms",
  evidence: "`unit:sandbox-live-identity.test.ts` (\"doc read denied when current user lacks read access\"), oracle: `packages/conformance/observations/firestore/firestore-read-denied-error-code.json` (prod `getDoc` on a denied path throws a `FirebaseError` with `.code === 'permission-denied'`, `.message === 'Missing or insufficient permissions.'`, `instanceof Error`)",
  risk: ["specific-value","error-code","specific-field","rules-denial"],
  riskScore: 8,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `permission-denied`","asserts a specific field/property value","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["firestore-read-denied-error-code"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-live-identity.test.ts","packages/pyric/test/sandbox/firestore/admin-compat/query-rules-enforcement.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
  conformanceChecks: [{"finding":"FS-B1","observation":"firestore-read-denied-error-code","expect":{},"probe":"packages/pyric/test/sandbox/firestore/admin-compat/query-rules-enforcement.test.ts","guards":"getDocs/query reads enforce security rules — a denied query throws permission-denied (no silent bypass)."}],
});
