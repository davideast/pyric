import { row } from './section.ts';

export default row({
  order: 90,
  featureKeys: ["limitToFirst"],
  behavior: "`limitToFirst(N)` caps the result count from the start of the ordered range",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-query-orderbychild-limit.json` plus `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` (firstPositions `[1,2]`).",
  oracleObservations: ["rtdb-modular-limittofirst-vs-limittolast","rtdb-modular-orderbyvalue-numeric","rtdb-modular-query-orderbychild-limit"],
  aliases: ["rtdb#150"],
});
