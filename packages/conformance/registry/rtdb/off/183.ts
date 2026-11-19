import { row } from './section.ts';

export default row({
  order: 50,
  api: "off(ref, eventType, callback)",
  behavior: "When the same callback is registered more than once, each `off(ref, eventType, callback)` removes one registration without orphaning the others",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-off-duplicate-registration` proves each matching `off` removes one registration; sandbox row assertion `rtdb-modular#183` replays the full sequence.",
  risk: ["listener","stateful"],
  riskScore: 4,
  riskReasons: ["asserts registration identity and repeated unsubscribe ordering"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-duplicate-registration"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-183",
    observation: "rtdb-modular-off-duplicate-registration",
    expect: { repeatCount: 2, afterInitial: [0,0], afterFirstWrite: [0,0,1,1], afterFirstOff: [0,0,1,1,2], afterSecondOff: [0,0,1,1,2] },
    probe: "packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts",
    guards: "Each duplicate off call removes one matching registration without orphaning the other.",
  }],
  aliases: ["rtdb#183"],
});
