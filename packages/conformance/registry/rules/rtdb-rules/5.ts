import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: [],
  behavior: "Cascade is GRANT-ONLY — a root `.read: true` grants every descendant read (authed and anonymous), and a deeper `.write: false` cannot revoke a truthy ancestor `.write` grant",
  evidence: "`oracle:rules-rtdb-r5-cascade-root-grant` — production verdicts captured by deploy-observe-restore, replayed verdict-for-verdict; all 4 cases ALLOW in production, including the write to a node whose own `.write` is literal `false`. The simulator reproduces grant-only cascade rather than treating the deeper `false` as a veto.",
  oracleObservations: ["rules-rtdb-r5-cascade-root-grant"],
  constructs: ["rtdb.semantic.read-cascade","rtdb.semantic.write-cascade"],
});
