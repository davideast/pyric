import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["signInWithCustomToken"],
  api: "signInWithCustomToken(auth, customToken)",
  behavior: "Throws `auth/invalid-custom-token` for a malformed token and for the empty string. `createCustomToken` in pyric-admin and the CLI mints a custom token in firebase-admin's shape (an RS256 JWT for the identity toolkit audience with `uid` and `claims`), signed with a sandbox key for the minting app's project, and this exchanges it (#1952): an edited signature or an `exp` on or before the sandbox clock's now throws `auth/invalid-custom-token`, and a token for another project throws `auth/custom-token-mismatch`. Every unsigned token throws `auth/invalid-custom-token`, as production answers a token it cannot verify (#2009): a JSON (optionally base64url) `{uid, claims}` payload, a three-part JWT for any other audience or none, and a custom-token-audience JWT the sandbox did not sign. The identity is created if it does not exist, and the credential carries `providerId: null` (custom-token sign-in is not a federated provider).",
  status: "diverged-documented",
  evidence: "ORACLE-BACKED on the reject path: `auth-signinwithcustomtoken-invalid` captured `auth/invalid-custom-token` for both a malformed token and the empty string, replayed in `unit:oracle-conformance.test.ts`. The mismatch and expiry codes follow @firebase/auth's server error map (`CREDENTIAL_MISMATCH` to `custom-token-mismatch`, `INVALID_CUSTOM_TOKEN` to `invalid-custom-token`), not a capture. Diverged on the accept path, declared rather than hidden: prod verifies an RS256 signature against the project's service-account key, and the sandbox has none, so a token signed with a real key is refused. The mint, exchange and verify round trip runs in `packages/pyric-admin/src/auth/custom-token-exchange.test.ts` and the `id-token-bearer-header` app scenario, and each unsigned shape is refused in `packages/pyric/test/auth/unsigned-custom-token.test.ts`, `packages/cli/test/serve/worker/unsigned-custom-token.test.ts` and that scenario.",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/invalid-custom-token`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-signinwithcustomtoken-invalid"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts"],
});
