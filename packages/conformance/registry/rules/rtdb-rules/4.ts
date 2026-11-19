import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: [],
  behavior: "`.validate` VETO — a failing child `.validate` denies a write the `.write` rule would otherwise permit (validate does not cascade and cannot be overridden)",
  evidence: "`oracle:rules-rtdb-r4-validate-structure` — production verdicts captured by deploy-observe-restore, replayed verdict-for-verdict; both cases match production. This row was the corpus's one historical simulator-vs-production divergence: at the 2026-05-18 agreement capture the simulator ALLOWED the missing-body write because it did not veto on the child `.validate`. The simulator now denies it, and this fresh capture re-confirms production's DENY, so the divergence is RESOLVED and needs no pin.",
  oracleObservations: ["rules-rtdb-r4-validate-structure"],
  constructs: ["rtdb.semantic.validate-non-cascade","rtdb.semantic.write-cascade"],
});
