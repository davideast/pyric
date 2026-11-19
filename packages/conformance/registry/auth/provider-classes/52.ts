import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["GoogleAuthProvider"],
  behavior: "`GoogleAuthProvider.providerId === 'google.com'` (and per-provider analogs)",
  status: "conforms",
  evidence: "`unit:sandbox-providers.test.ts` + oracle: `packages/conformance/observations/auth/auth-provider-classes-and-saml-guard.json` (verifies static `PROVIDER_ID`, sign-in method constants, and instance `providerId` across all shipped provider classes on `firebase/auth` 12.19.0)",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["auth-provider-classes-and-saml-guard"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-providers.test.ts","packages/pyric/test/auth/oracle-captures/auth-providers-and-credentials.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-providers-and-credentials.test.ts"],
});
