import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["GoogleAuthProvider","EmailAuthProvider"],
  behavior: "`Provider.credential(...)` static factories produce `AuthCredential`-shaped objects",
  status: "conforms",
  evidence: "`unit:sandbox-providers.test.ts` + oracle: `packages/conformance/observations/auth/auth-credential-factories-and-json-roundtrip.json` (verifies static and instance `credential` / `credentialWithLink` factories, `instanceof AuthCredential`, and `toJSON` / `fromJSON` round-trips across `firebase/auth` 12.19.0)",
  automation: "oracle-backed",
  oracleObservations: ["auth-credential-factories-and-json-roundtrip"],
  conformanceTests: ["packages/pyric/test/auth/sandbox-providers.test.ts","packages/pyric/test/auth/oracle-captures/auth-providers-and-credentials.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-providers-and-credentials.test.ts"],
});
