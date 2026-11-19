import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Removes the value AND all children; subsequent `get` returns `null`-val snapshot",
  evidence: "oracle: `packages/conformance/observations/rtdb/rtdb-remove-vs-set-null.json`",
  oracleObservations: ["rtdb-remove-vs-set-null"],
  aliases: ["rtdb#121"],
});
