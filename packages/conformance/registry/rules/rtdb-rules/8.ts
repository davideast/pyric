import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: [],
  behavior: "`data` and `newData` are bound at the RULE node, not the written path — an ancestor `.write` sees the pre-write subtree in `data` and the merged post-write subtree in `newData` across descendant sets, deep creates, leaf deletes, and multi-path updates",
  evidence: "`oracle:rules-rtdb-r8-combined-check` — production verdicts captured by deploy-observe-restore, replayed verdict-for-verdict. Production DENIES all three writes, including the \"matching owner\" case whose `owner` field lives under `/item` rather than at the rule node; only the auth-gated read allows. All 4 cases match, so the simulator projects `newData` at the same node production does — rule placement relative to the written path decides the outcome. Extended 2026-11-07: `oracle:rules-rtdb-r63-ancestor-write-data-newdata` captures an ancestor `$m` `.write` reading both `data.child('speaker').child('uid')` and `newData.child('speaker').child('uid')`: production ALLOWS an owner deep-writing `content` (merged `newData` retains `speaker`), ALLOWS an owner leaf-deleting `content/text`, and ALLOWS creating `/msgs/m2` with own `speaker`, while DENYING a non-owner deep write, a non-owner rewriting `speaker/uid` to self (`data` at `$m` remains pre-write), a deep create at `/msgs/m3/content` without `speaker` (`newData` at `$m` lacks `speaker`), and a non-owner multi-path update from `/msgs`. All 7 cases match production.",
  oracleObservations: ["rules-rtdb-r8-combined-check", "rules-rtdb-r63-ancestor-write-data-newdata"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts"],
  constructs: ["rtdb.semantic.read-cascade", "rtdb.semantic.write-cascade", "rtdb.binding.data", "rtdb.binding.newData"],
});
