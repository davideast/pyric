import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Update path validation — overlapping paths (e.g. `'/a'` and `'/a/x'` in the same call) throws synchronously before any write",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-write-return-validation` captures a synchronous ancestor-path error and unchanged terminal state; sandbox row assertion `rtdb-modular#120` matches both.",
  risk: ["specific-value","timing"],
  riskScore: 4,
  riskReasons: ["asserts 2 specific value(s)","asserts timing semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-write-return-validation"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-120",
    observation: "rtdb-modular-write-return-validation",
    expect: { repeatCount: 2, overlapping: { timing: "synchronous-throw", name: "Error", code: null, message: "update failed: values argument contains a path /a that is ancestor of another path /a/b" }, afterRejected: { seed: true } },
    probe: "packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts",
    guards: "Overlapping update paths fail synchronously and atomically preserve prior data.",
  }],
  aliases: ["rtdb#120"],
});
