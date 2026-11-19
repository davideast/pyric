import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "`remove(ref)` and `set(ref, null)` produce the same end state — locks the documented RTDB invariant",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json`",
  oracleObservations: ["rtdb-remove-vs-set-null"],
  aliases: ["rtdb#123"],
});
