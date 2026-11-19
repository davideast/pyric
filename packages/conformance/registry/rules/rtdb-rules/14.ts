import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["root"],
  behavior: "The `root` binding — `root.child(...).exists()` resolved against the database root",
  evidence: "NEW ROW, 2026-07-12: production capture proves the simulator resolves the `root` binding and reports a missing child as absent exactly as production does. The scope is bounded by the rig: the capture runner mounts the scenario subtree under a per-run randomly-named namespace while the replay suite mounts it at the root, so a rule naming any PRESENT path through `root` would address a different node on each side and diverge for harness reasons. Only a sentinel key absent under BOTH roots is mount-invariant, so that is what this row verifies; a populated `root` lookup remains unverified and needs a rig that can seed outside the scenario subtree and mount both sides at the same depth. `oracle:rules-rtdb-r14-root-lookup` matches production verdict-for-verdict on all 3 cases.",
  oracleObservations: ["rules-rtdb-r14-root-lookup"],
});
