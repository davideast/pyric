import { row } from './section.ts';

export default row({
  order: 1010,
  featureKeys: ["runTransaction"],
  behavior: "`TransactionResult` is exported as a runtime constructor value and transaction results satisfy Firebase's observable prototype, `instanceof`, and `toJSON()` contract.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-runtime-class-identity`; sandbox row assertion `rtdb-modular#M88` replays runtime identity and `toJSON()`.",
  risk: ["structural","atomicity"],
  riskScore: 2,
  riskReasons: ["structural / routing-only claim","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtime-class-identity"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-runtime-identity.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M88",
    observation: "rtdb-modular-runtime-class-identity",
    expect: { repeatCount: 2, transactionResult: { constructorName: "TransactionResult", instanceOf: true, prototypeIsExportPrototype: true, prototypeKeys: ["constructor","toJSON"], toJSONType: "function", toJSON: { committed: true, snapshot: 1 } } },
    probe: "packages/pyric/test/database/modular/oracle-conformance-runtime-identity.test.ts",
    guards: "TransactionResult retains its runtime identity and captured toJSON contract.",
  }],
  rowNumber: 88,
});
