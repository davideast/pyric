import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["GoogleAuthProvider","EmailAuthProvider"],
  behavior: "Exports the same constructor signatures as `firebase/auth` for each provider",
  status: "conforms",
  evidence: "`unit:types.test.ts` + oracle: `packages/conformance/observations/auth/auth-provider-classes-and-saml-guard.json` (verifies constructor signatures, chainable `addScope` / `setCustomParameters`, and `credentialFromError` across `GoogleAuthProvider`, `EmailAuthProvider`, `FacebookAuthProvider`, `GithubAuthProvider`, `TwitterAuthProvider`, `OAuthProvider`, and `SAMLAuthProvider` on `firebase/auth` 12.19.0)",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["auth-provider-classes-and-saml-guard"],
  conformanceTests: ["packages/pyric/test/auth/types.test.ts","packages/pyric/test/auth/oracle-captures/auth-providers-and-credentials.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-providers-and-credentials.test.ts"],
});
