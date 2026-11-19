import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["getAfter","existsAfter"],
  behavior: "`getAfter()`/`existsAfter()` expose the projected post-write target and cross-document atomic batch state; create exists, delete does not, and an unrelated unchanged document falls back to its committed existence",
  status: "conforms",
  evidence: "`oracle:rules-firestore-get-after-and-exists-after` records authenticated Web SDK verdicts against temporarily deployed production rules, including target create/delete and unrelated-path semantics. Its lifecycle proves exact rules release restoration; retained diagnostics document why the hosted Rules Test API was not sufficient. Replayed verdict-for-verdict by `unit:rules/oracle-conformance.test.ts`; `get-after.test.ts` and `get-after-batch.test.ts` cover target, sibling-write, solo-write denial, delete, and atomicity locally.",
  risk: ["specific-value","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-get-after-and-exists-after"],
  automation: "oracle-backed",
  conformanceTests: ["packages/pyric/test/rules/oracle-conformance.test.ts","packages/pyric/test/sandbox/firestore/simulator/get-after.test.ts","packages/pyric/test/sandbox/firestore/simulator/get-after-batch.test.ts"],
  constructs: ["firestore.function.getAfter","firestore.function.existsAfter"],
});
