import { row } from './section.ts';

export default row({
  order: 870,
  featureKeys: ["onChildMoved","query"],
  behavior: "`onChildMoved` fires when an ordered child changes position and co-fires with `child_changed` when Firebase does, preserving the captured `previousChildName` sequence.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-child-previous-name` and the modular oracle suite replay ordered movement, co-fire behavior, and predecessor sequencing. As `rtdb-modular-childchanged-cofire-with-childmoved` records for a same-rank change of the ordered field, `ValueIndex` (`orderByValue()`) moves when the child value changes structurally (even across objects) while `PathIndex` (`orderByChild()`) moves when `compareValues` is non-zero (moving on same-rank scalar changes while keeping object-to-object edits stationary); `unit:modular/priority-listeners.test.ts` pins both.",
  risk: ["listener","listener-fire-count","specific-value"],
  riskScore: 6,
  riskReasons: ["asserts listener semantics","asserts a specific listener fire count","asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-child-previous-name","rtdb-modular-childchanged-cofire-with-childmoved","rtdb-modular-onchildmoved-previouschildname-sequencing"],
  conformanceTests: ["packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts","packages/pyric/test/database/modular/oracle-conformance-listeners.test.ts","packages/pyric/test/database/modular/priority-listeners.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M75C",
    observation: "rtdb-modular-child-previous-name",
    expect: { moved: [["c",null]] },
    probe: "packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts",
    guards: "Ordered movement preserves the captured predecessor alongside co-fire and multi-move sequencing evidence.",
  }, {
    finding: "RTDB-M75C-COFIRE",
    observation: "rtdb-modular-childchanged-cofire-with-childmoved",
    expect: { reorderChanged: 1, reorderMoved: 1, nonOrderChanged: 1, nonOrderMoved: 0, sameRankChanged: 1, sameRankMoved: 1 },
    probe: "packages/pyric/test/database/modular/oracle-conformance-listeners.test.ts",
    guards: "child_changed and child_moved co-fire exactly where production captured them.",
  }, {
    finding: "RTDB-M75C-SEQUENCE",
    observation: "rtdb-modular-onchildmoved-previouschildname-sequencing",
    expect: { totalMoves: 3, prevNameSequence: ["k3","k2",null], movedKeySequence: ["k1","k1","k1"] },
    probe: "packages/pyric/test/database/modular/oracle-conformance-listeners.test.ts",
    guards: "Repeated ordered movement keeps the production predecessor-name sequence.",
  }],
});
