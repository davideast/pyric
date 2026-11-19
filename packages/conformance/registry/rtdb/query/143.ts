import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["orderByKey"],
  behavior: "`orderByKey()` orders by the auto-id / numeric key",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-orderbykey-window.json` — seeded `{a,b,c,d,e}` in shuffled insertion order, observed `matchedKeys: ['b','c','d']` for `orderByKey() + startAt('b') + endAt('d')` (in key order).",
  oracleObservations: ["rtdb-modular-orderbykey-window"],
  aliases: ["rtdb#143"],
});
