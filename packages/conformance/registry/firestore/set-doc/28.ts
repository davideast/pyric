import { row } from './section.ts';

export default row({
  order: 30,
  automation: "oracle-backed",
  behavior: "`{ mergeFields: [...] }` writes only the listed dot-separated string and `FieldPath` paths into the existing doc (FS-B6), ignoring unmasked input keys, preserving other stored fields, and creating `{}` on `{ mergeFields: [] }` when absent",
  evidence: "`unit:sandbox-target.test.ts`, `unit:admin-compat/field-path-merge.test.ts`, `unit:upstream-write-aggregate-probes.test.ts`, `oracle:firestore-setdoc-mergefields-dotted-and-fieldpath`",
  oracleObservations: ["firestore-setdoc-mergefields-dotted-and-fieldpath"],
  conformanceTests: ["packages/pyric/test/firestore/sandbox-target.test.ts", "packages/pyric/test/sandbox/firestore/admin-compat/field-path-merge.test.ts", "packages/pyric/test/firestore/upstream-write-aggregate-probes.test.ts", "packages/pyric/test/firestore/oracle-captures/firestore-setdoc.test.ts", "packages/cli/test/serve/worker/oracle-captures/firestore-setdoc.test.ts"],
});
