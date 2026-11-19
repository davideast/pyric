import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["onChildMoved"],
  behavior: "`onChildMoved` under an explicit ordered query fires when the ordered field changes, co-fires with `child_changed`, and supplies the captured `previousChildName`.",
  status: "conforms",
  evidence: "Oracle observations `rtdb-modular-onchildmoved-with-orderby`, `rtdb-modular-onchildmoved-previouschildname-sequencing`, and `rtdb-modular-childchanged-cofire-with-childmoved` are replayed by the modular oracle suite.",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  oracleObservations: ["rtdb-modular-onchildmoved-with-orderby","rtdb-modular-onchildmoved-previouschildname-sequencing","rtdb-modular-childchanged-cofire-with-childmoved"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-listeners.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-137-MOVE",
    observation: "rtdb-modular-onchildmoved-with-orderby",
    expect: { firedOnInitial: 0, firedOnMove: 1, noInitialReplay: true, firesOnReorder: true },
    probe: "packages/pyric/test/database/modular/oracle-conformance-listeners.test.ts",
    guards: "Ordered child movement fires once on reorder and never replays initially.",
  }, {
    finding: "RTDB-137-SEQUENCE",
    observation: "rtdb-modular-onchildmoved-previouschildname-sequencing",
    expect: { totalMoves: 3, prevNameSequence: ["k3","k2",null], movedKeySequence: ["k1","k1","k1"] },
    probe: "packages/pyric/test/database/modular/oracle-conformance-listeners.test.ts",
    guards: "Movement to end, middle, and front keeps the captured predecessor sequence.",
  }, {
    finding: "RTDB-137-COFIRE",
    observation: "rtdb-modular-childchanged-cofire-with-childmoved",
    expect: { reorderChanged: 1, reorderMoved: 1, nonOrderChanged: 1, nonOrderMoved: 0, sameRankChanged: 1, sameRankMoved: 1 },
    probe: "packages/pyric/test/database/modular/oracle-conformance-listeners.test.ts",
    guards: "child_changed and child_moved co-fire exactly where production captured them.",
  }],
  aliases: ["rtdb#137"],
});
