import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["auth"],
  behavior: "`auth != null` gate on `.read`/`.write` — authed ops allow, signed-out ops deny",
  evidence: "`oracle:rules-rtdb-r1-auth-only` — production verdicts captured by deploy-observe-restore against the live oracle database (RTDB has no server-side rules test API), replayed verdict-for-verdict against the in-process simulator by `packages/rules/test/rtdb/rules-conformance.test.ts`; all 4 cases match production.",
  oracleObservations: ["rules-rtdb-r1-auth-only"],
});
