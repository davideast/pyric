import { row } from './section.ts';

export default row({
  order: 1030,
  featureKeys: ["orderByPriority"],
  behavior: "`orderByPriority` orders by Firebase priority with key tie-breaking and composes with bounds, equality, and limits; plain snapshots and unconstrained queries use the same default priority index, and invalid priority bounds throw synchronously.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-priority-contract` captures priority order, key tie-breaking, bounds, and limits; replayed by `unit:modular/priority-metadata-cdd.test.ts`.",
  risk: ["specific-value"],
  riskScore: 1,
  riskReasons: ["asserts 1 specific value(s)"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-priority-contract"],
  conformanceTests: ["packages/pyric/test/database/modular/priority-metadata-cdd.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M90",
    observation: "rtdb-modular-priority-contract",
    expect: { plainForEachKeys: ["b","c","a"], defaultLimitedKeys: ["b","c"], invalidPriorityBounds: { boolean: { timing: "synchronous-throw", name: "Error", code: null, message: "Query: When ordering by priority, the first argument passed to startAt(), startAfter() endAt(), endBefore(), or equalTo() must be a valid priority value (null, a number, or a string)." }, object: { timing: "synchronous-throw", name: "Error", code: null, message: "Query: When ordering by priority, the first argument passed to startAt(), startAfter() endAt(), endBefore(), or equalTo() must be a valid priority value (null, a number, or a string)." }, defaultBoolean: { timing: "synchronous-throw", name: "Error", code: null, message: "Query: When ordering by priority, the first argument passed to startAt(), startAfter() endAt(), endBefore(), or equalTo() must be a valid priority value (null, a number, or a string)." }, defaultObject: { timing: "synchronous-throw", name: "Error", code: null, message: "Query: When ordering by priority, the first argument passed to startAt(), startAfter() endAt(), endBefore(), or equalTo() must be a valid priority value (null, a number, or a string)." } } },
    probe: "packages/pyric/test/database/modular/priority-metadata-cdd.test.ts",
    guards: "Default priority ordering and invalid-bound timing stay pinned to production.",
  }],
  rowNumber: 90,
});
