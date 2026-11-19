import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: [],
  behavior: "Write-rule CASCADE — a truthy ancestor `.write` grants the write regardless of a deeper `!data.exists()` rule, so the populated-path write ALLOWS",
  evidence: "`oracle:rules-rtdb-r3-data-exists` — production verdicts captured by deploy-observe-restore, replayed verdict-for-verdict. Production ALLOWS the write to the populated path even though the child rule is `!data.exists()`: the ancestor `.write: auth != null` already granted it, and RTDB never consults a deeper rule to revoke a grant. All 3 cases match; the simulator models the same cascade.",
  oracleObservations: ["rules-rtdb-r3-data-exists"],
  constructs: ["rtdb.semantic.write-cascade","rtdb.semantic.read-cascade"],
});
