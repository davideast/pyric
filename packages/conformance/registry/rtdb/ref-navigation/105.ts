import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["ref"],
  behavior: "Unknown ref (not produced by this package) → `TypeError` in shim ops",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-reference-shape-url` captures a synchronous `TypeError`; sandbox row assertion `rtdb-modular#105` matches its timing and constructor.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-reference-shape-url"],
  conformanceTests: ["packages/pyric/test/database/modular/oracle-conformance-reference-writes.test.ts"],
  aliases: ["rtdb#105"],
});
