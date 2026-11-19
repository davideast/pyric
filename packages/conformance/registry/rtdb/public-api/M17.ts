import { row } from './section.ts';

export default row({
  order: 180,
  featureKeys: ["ref","push"],
  behavior: "`push(ref)` mints a 20-char auto-id key starting with `-`, lexicographically sortable",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-target.test.ts` (\"mints 20-char keys starting with \\\"-\\\"\" + \"sequential push keys are lex-sortable\"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json`",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-push-autoid-format"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts"],
  rowNumber: 17,
});
