import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "After package swapping, bare `getAuth()` resolves the registered default sandbox app; without swapping, Firebase retains its `app/no-app` behavior when no default app exists",
  status: "conforms",
  statusNote: "(wrap)",
  evidence: "canonical Node register child (`register-child.test.ts`) + oracle: `packages/conformance/observations/auth/auth-bare-getauth-no-default-app.json` (`code: 'app/no-app'` against digame-mas, fb-js-sdk 12.19.0 — confirms unswapped Firebase behavior)",
  risk: ["specific-value","error-code","specific-field"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `app/no-app`","asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-bare-getauth-no-default-app"],
  conformanceTests: ["packages/cli/test/register/register-child.test.ts"],
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
