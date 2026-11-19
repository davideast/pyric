import { row } from './section.ts';

export default row({
  order: 20,
  rowNumber: 49,
  automation: "oracle-backed",
  behavior: "Sandbox auth errors are real `FirebaseError` instances (`err instanceof FirebaseError`) carrying the prod message wrapper `Firebase: <message> (<auth/...>).` - e.g. `Firebase: Error (auth/invalid-email).`, matching the oracle (AUTH-GAP)",
  evidence: "`unit:auth-gap-surface.test.ts`, oracle: `auth-setpersistence-and-firebaseerror-wrapper.json`",
  oracleObservations: ["auth-setpersistence-and-firebaseerror-wrapper"],
  conformanceTests: ["packages/pyric/test/auth/auth-gap-surface.test.ts","packages/pyric/test/auth/oracle-captures/auth-handles-persistence-disabled.test.ts","packages/cli/test/serve/worker/oracle-captures/auth-handles-persistence-disabled.test.ts"],
});
