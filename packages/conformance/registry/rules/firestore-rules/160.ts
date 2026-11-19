import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["math","timestamp","duration"],
  behavior: "CEL builtins `math.*`/`timestamp.*`/`duration.*` (FM3) — arithmetic, date, and duration comparisons in rules",
  status: "conforms",
  evidence: "`oracle:rules-firestore-builtins-time-and-math` — production Firestore Rules Test API verdicts for corpus scenario \"builtins-time-and-math\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production.",
  oracleObservations: ["rules-firestore-builtins-time-and-math"],
});
