import { row } from './section.ts';

export default row({
  order: 1050,
  featureKeys: ["off","query","onValue"],
  behavior: "`off(query)` removes listeners only from the equivalent constrained query view, while `off(ref)` removes listeners from every query view at that path.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-off-duplicate-registration` captures exact constrained-query removal and all-view reference removal with independent live-listener controls; replayed by `unit:modular/sandbox-child-events.test.ts`.",
  risk: ["listener","stateful"],
  riskScore: 4,
  riskReasons: ["asserts listener semantics","asserts registration identity and unsubscribe scope"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-duplicate-registration"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M92",
    observation: "rtdb-modular-off-duplicate-registration",
    expect: { repeatCount: 2, queryScope: { afterQueryOff: { defaultCount: 2, orderedCount: 1 }, reorderedEquivalentStopped: true, defaultQueryStoppedReference: true, constrainedStoppedByRefOff: true } },
    probe: "packages/pyric/test/database/modular/sandbox-child-events.test.ts",
    guards: "Query-scoped off is exact while reference-scoped off removes every view at the location.",
  }],
  rowNumber: 92,
});
