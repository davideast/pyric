import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["pathVariables"],
  behavior: "Nested path variable in an expression (`$sessionId === auth.uid`) — the matching session allows, a mismatched session denies, and an unmatched anonymous op denies with no matching rule",
  evidence: "`oracle:rules-rtdb-r7-pathvar-binding`: production verdicts captured by deploy-observe-restore, replayed verdict-for-verdict; all 4 cases match. The simulator binds the nested variable identically and denies the anonymous read of `sessions`, a node with only children and no ancestor `.read` that grants, as production does.",
  oracleObservations: ["rules-rtdb-r7-pathvar-binding"],
});
