import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["unlink"],
  api: "unlink(user, providerId)",
  behavior: "Detaches a provider and returns the updated user with a SHRUNKEN `providerData`. Unlinking a provider that was never linked throws `auth/no-such-provider`. Unlinking `'password'` takes the password with it, so `signInWithEmailAndPassword` for that account stops working. Unlinking the LAST provider does NOT re-anonymize the account — `isAnonymous` describes how an identity was born, not what it currently carries.",
  evidence: "ORACLE-BACKED on the reject path — the ONE linking fact the oracle could reach, because it needs no email credential: `auth-unlink-provider` captured `noSuchProviderCode: auth/no-such-provider` against prod on an anonymous user. Replayed in `unit:oracle-conformance.test.ts`. The detach path is unit-backed (`unit:sandbox-linking-reauth.test.ts`).",
  risk: ["error-code"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code(s): `auth/no-such-provider`"],
  automation: "oracle-backed",
  oracleObservations: ["auth-unlink-provider"],
  conformanceTests: ["packages/pyric/test/auth/oracle-conformance.test.ts","packages/pyric/test/auth/sandbox-linking-reauth.test.ts"],
});
