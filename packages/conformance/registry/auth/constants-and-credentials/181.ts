import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["TwitterAuthProvider","SAMLAuthProvider"],
  api: "TwitterAuthProvider / SAMLAuthProvider",
  behavior: "Provider marker classes. `TwitterAuthProvider.credential(token, secret)` takes a token AND a secret -- Twitter is the one OAuth 1.0a provider in the set, where the OAuth 2.0 providers take a single access token. `SAMLAuthProvider`'s constructor ENFORCES the `saml.` providerId prefix (throwing `auth/argument-error` otherwise), because that id is what routes an assertion to the right configured IdP and a typo there would silently target nothing. SAML has no client-constructible credential, so the class has no `credential()` factory.",
  status: "conforms",
  evidence: "`unit:types.test.ts` + oracle: `packages/conformance/observations/auth/auth-provider-classes-and-saml-guard.json` and `packages/conformance/observations/auth/auth-credential-factories-and-json-roundtrip.json` (construction, `PROVIDER_ID` values, OAuth 1.0a token+secret round-trip, and `SAMLAuthProvider` `saml.` prefix guard on `firebase/auth` 12.19.0).",
  automation: "oracle-backed",
  oracleObservations: ["auth-provider-classes-and-saml-guard","auth-credential-factories-and-json-roundtrip"],
  conformanceTests: ["packages/pyric/test/auth/types.test.ts","packages/pyric/test/auth/oracle-captures/auth-providers-and-credentials.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-providers-and-credentials.test.ts"],
});
