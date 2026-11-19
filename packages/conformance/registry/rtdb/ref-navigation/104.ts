import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["ref","root"],
  behavior: "`ref.key` is the final path segment, `null` for root",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url`; sandbox row assertion `rtdb-modular#104`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  aliases: ["rtdb#104"],
});
