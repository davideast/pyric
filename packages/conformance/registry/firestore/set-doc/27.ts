import { row } from './section.ts';

export default row({
  order: 20,
  automation: "oracle-backed",
  behavior: "`{ merge: true }` **deep-merges nested maps** (FS-B6), preserving unspecified sibling fields at every depth, replacing arrays, and creating absent documents (`setDoc({a:{b:2}}, {merge:true})` over `{a:{c:1}}` yields `{a:{b:2,c:1}}`)",
  evidence: "`unit:sandbox-target.test.ts`, `unit:admin-compat/field-path-merge.test.ts` (FS-B6 nested deep-merge), `oracle:firestore-setdoc-merge-true-deep-merges-maps`",
  oracleObservations: ["firestore-setdoc-merge-true-deep-merges-maps"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/sandbox/firestore/admin-compat/field-path-merge.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-setdoc.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-setdoc.test.ts"],
});
