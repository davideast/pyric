import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Idempotent — `signOut` on already-signed-out user is a no-op (no listener fire)",
  status: "conforms",
  evidence: "`playground:auth-signout-idempotent` + oracle-confirmed: `packages/conformance/observations/auth/auth-signout-idempotent.json` (`threw: false, redundantSignOutFiredListener: false` against digame-mas)",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["auth-signout-idempotent"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
