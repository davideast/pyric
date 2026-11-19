import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "`auth` context: when `null`, `auth` is null inside expressions; when present, `auth.uid` and `auth.token.*` are bound",
  status: "conforms",
  evidence: "Oracle `rtdb-rules-cascade-bindings-and-auth-context` records `auth == null` vs `auth.uid` and `auth.token.firebase.sign_in_provider` evaluation; replayed alongside `unit:simulation/handler.test.ts` and `unit:grammar/simulator.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-cascade-bindings-and-auth-context"],
  conformanceTests: ["packages/rules/test/rtdb/grammar/simulator.test.ts", "packages/pyric/test/rules/rtdb/simulation/handler.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts", "packages/cli/test/serve/worker/oracle-captures/rtdb-rules-evaluation-and-roundtrip.test.ts"],
});
