import { row } from './section.ts';

export default row({
  order: 840,
  featureKeys: ["onChildAdded","onChildChanged","onChildRemoved","onChildMoved"],
  behavior: "Child-listener callbacks receive Firebase's `previousChildName` second argument, including initial replay and ordered-query movement.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-child-previous-name` captures initial replay plus add/change/remove/move predecessor values; replayed by `unit:modular/listener-lifecycle-cdd.test.ts`.",
  risk: ["specific-value","listener"],
  riskScore: 4,
  riskReasons: ["asserts 1 specific value(s)","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-child-previous-name"],
  conformanceTests: ["packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M75",
    observation: "rtdb-modular-child-previous-name",
    expect: { repeatCount: 2, initialAdded: [["a",null],["b","a"],["c","b"]], postMutationAdded: [["d","c"]], changed: [["b","a"],["c","b"]], removed: [["a",null]], moved: [["c",null]], plainPriorityAdded: [["a",null],["z","a"]] },
    probe: "packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts",
    guards: "Child listeners preserve captured predecessor values for replay, mutation, removal, and movement.",
  }],
  rowNumber: 75,
});
