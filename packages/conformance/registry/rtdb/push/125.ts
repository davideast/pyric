import { row } from './section.ts';

export default row({
  order: 20,
  behavior: "Sequential `push` calls produce monotonically-sortable keys (timestamp-prefixed for chronological ordering via `orderByKey`)",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-push-autoid-format.json`",
  oracleObservations: ["rtdb-push-autoid-format"],
  aliases: ["rtdb#125"],
});
