import { row } from './section.ts';

export default row({
  order: 390,
  featureKeys: ["ref","child","off"],
  behavior: "`off(ref)` (no event type) removes ALL listeners at that ref — value + every child event variety",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-child-events.test.ts` (\"off(ref) removes ALL listeners at the ref\" + \"off(ref) also removes value listeners at the same path\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-off-stops-child-fires.json` (`postOffFires: 0`).",
  risk: ["specific-field","listener"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-off-stops-child-fires"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-child-events.test.ts"],
  rowNumber: 47,
});
