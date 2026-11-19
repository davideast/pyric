import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["query","orderByChild","limitToFirst"],
  behavior: "`query(ref, orderByChild('field'), limitToFirst(N))` returns a `Query` whose `get()` resolves a snapshot containing N children ordered by `field`",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-orderbychild-limit.json` — seeded 4 children with positions `[3,1,4,2]`, observed `orderedKeys: [{key:'a',pos:1}, {key:'b',pos:2}]` (first 2 in ascending order). Requires `.indexOn` declared in rules.",
  oracleObservations: ["rtdb-modular-orderbychild-window","rtdb-modular-query-orderbychild-limit"],
  aliases: ["rtdb#142"],
});
