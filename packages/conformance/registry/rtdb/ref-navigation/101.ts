import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["ref","parent","root"],
  behavior: "`ref(db)` with no path returns the root ref (`key === null`, `parent === null`)",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url`; sandbox row assertion `rtdb-modular#101`.",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  aliases: ["rtdb#101"],
});
