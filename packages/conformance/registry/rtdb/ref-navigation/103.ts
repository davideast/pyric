import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["ref","parent","root"],
  behavior: "`ref.parent` is `null` at root, otherwise the parent ref",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url`; sandbox row assertion `rtdb-modular#103`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  aliases: ["rtdb#103"],
});
