import { row } from './section.ts';

export default row({
  order: 1020,
  featureKeys: ["setPriority","setWithPriority"],
  behavior: "`setPriority` and `setWithPriority` store, replace, preserve, and clear valid RTDB priority metadata; parent `exportVal()` and `toJSON()` recursively include descendant priority metadata.",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-priority-contract` captures round-trip/export shape, update/transaction preservation, plain-set clearing, and explicit clearing; replayed by `unit:modular/priority-metadata-cdd.test.ts`.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-priority-contract"],
  conformanceTests: ["packages/pyric/test/database/modular/priority-metadata-cdd.test.ts"],
  conformanceChecks: [{
    finding: "RTDB-M89",
    observation: "rtdb-modular-priority-contract",
    expect: { parentExportVal: { b: { value: 2, ".priority": 5 }, c: { value: 3, ".priority": 5 }, a: { value: 1, ".priority": 10 } }, parentToJSON: { b: { value: 2, ".priority": 5 }, c: { value: 3, ".priority": 5 }, a: { value: 1, ".priority": 10 } } },
    probe: "packages/pyric/test/database/modular/priority-metadata-cdd.test.ts",
    guards: "Backup serialization recursively preserves descendant priorities for both exportVal and toJSON.",
  }],
  rowNumber: 89,
});
