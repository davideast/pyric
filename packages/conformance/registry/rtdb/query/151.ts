import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["limitToLast"],
  behavior: "`limitToLast(N)` caps from the end",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-limittofirst-vs-limittolast.json` — observed `lastKeys: ['d','e'], lastPositions: [4,5]` for `limitToLast(2)` on a 5-child collection ordered by `pos`.",
  oracleObservations: ["rtdb-modular-limittofirst-vs-limittolast"],
  aliases: ["rtdb#151"],
});
