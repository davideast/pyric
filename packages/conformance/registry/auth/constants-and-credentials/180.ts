import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["EmailAuthCredential","OAuthCredential"],
  api: "AuthCredential / EmailAuthCredential / OAuthCredential",
  behavior: "Real classes, not markers. `EmailAuthProvider.credential(email, password)` returns an `EmailAuthCredential` that CARRIES THE SECRET -- which is what makes `linkWithCredential`, `reauthenticateWithCredential`, and `signInWithCredential` decidable in the sandbox with no resolver and no mock (the backend already stores and verifies passwords). `credentialWithLink` validates the action link via `ActionCodeURL.parseLink`, carries the link, and serializes `parsed.code` in `toJSON().password`, while `signInMethod` discriminates (`'password'` vs `'emailLink'`). The backing secret is non-enumerable, so a spread or `Object.keys` walk does not pick it up; `toJSON()` DOES carry it alongside `tenantId`, matching upstream (whose `fromJSON` needs it to round-trip). `OAuthCredential` carries the IdP tokens, round-trips via `toJSON()` / `fromJSON()`, and routes OAuth sign-in through the resolver seam.",
  status: "conforms",
  evidence: "`unit:sandbox-linking-reauth.test.ts` + oracle: `packages/conformance/observations/auth/auth-credential-factories-and-json-roundtrip.json` and `packages/conformance/observations/auth/auth-email-credential-signin-and-providerdata.json` (locks `EmailAuthCredential` and `OAuthCredential` `toJSON` / `fromJSON` round-trips, `credentialWithLink` validation, and `signInWithCredential` email credential login against `firebase/auth` 12.19.0).",
  automation: "oracle-backed",
  oracleObservations: ["auth-credential-factories-and-json-roundtrip","auth-email-credential-signin-and-providerdata"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-linking-reauth.test.ts","packages/pyric/test/auth/oracle-captures/auth-providers-and-credentials.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-providers-and-credentials.test.ts"],
});
