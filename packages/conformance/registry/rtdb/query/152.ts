import { row } from './section.ts';

export default row({
  order: 110,
  featureKeys: ["query"],
  behavior: "Listeners on a `Query` (`onValue(q, …)`) emit only the windowed snapshot — NOT the parent ref's full data",
  evidence: "oracle: `packages/conformance/observations/rtdb-modular/rtdb-modular-onvalue-with-query.json` — seeded 3 children, watched first 2 by `pos`; observed 3 fires total: (1) initial `[a,b]`, (2) OUTSIDE-window write to `c/extra` did NOT fire, (3) INSIDE-window mutation of `a` re-fired, (4) new child `z` displaced `b` and re-fired. Outside-window writes are silent.",
  risk: ["specific-value","listener"],
  riskScore: 4,
  riskReasons: ["asserts 1 specific value(s)","asserts listener semantics"],
  oracleObservations: ["rtdb-modular-onvalue-with-query"],
  aliases: ["rtdb#152"],
});
