import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "`push(ref).key` is a 20-char string starting with `-`, available **synchronously** (client-side mint, no server round-trip required)",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json`",
  risk: ["timing"],
  riskScore: 2,
  riskReasons: ["asserts timing semantics"],
  oracleObservations: ["rtdb-push-autoid-format"],
  aliases: ["rtdb#124"],
});
