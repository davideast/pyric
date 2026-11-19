import { row } from './section.ts';

export default row({
  order: 880,
  featureKeys: ["onChildAdded","onChildChanged","onChildRemoved","onChildMoved"],
  behavior: "Child listener overloads accept `ListenOptions` directly or after a cancellation callback; `onlyOnce` stops delivery after Firebase's captured initial/event batch.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-child-listener-only-once` captures all four listener families, both overload shapes, the existing-child replay batch, and one-shot post-registration delivery; replayed by `unit:modular/listener-lifecycle-cdd.test.ts`.",
  risk: ["listener","listener-fire-count"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts a specific listener fire count"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-child-listener-only-once"],
  conformanceTests: ["packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M75D",
    observation: "rtdb-modular-child-listener-only-once",
    expect: { repeatCount: 2, added: [["c","b"],["b","a"],["a",null]], changed: [["a",null]], removed: [["b",null]], moved: [["a","c"]], cancellations: [] },
    probe: "packages/pyric/test/database/modular/listener-lifecycle-cdd.test.ts",
    guards: "ListenOptions onlyOnce preserves captured batch ordering and stops each child listener family.",
  }],
});
