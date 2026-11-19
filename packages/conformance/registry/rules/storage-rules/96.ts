import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: [],
  behavior: "`evaluateStorageRules` supports granular verbs (`get`/`list`/`create`/`update`/`delete`) alongside `read`/`write` umbrella expansion, comma-separated verb lists, and per-verb default-deny",
  status: "conforms",
  evidence: "STALE ROW, corrected 2026-07-10: production capture proves the evaluator already supports the full six-verb grant surface (umbrella read->{get,list}, write->{create,update,delete}, single granular grants, comma-separated grants, per-verb deny-by-default), matching production verdict-for-verdict on 12 of the scenario's 13 non-existence cases. `oracle:rules-storage-verbs-umbrella-granular` (all `read`/`write`/`get`/comma-verb cases). One related existence-semantics case in the same scenario diverges over-permissively and is carried by `#118 Rules` (the `resource == null` create-if-absent guard), not by this granular-verb row.",
  oracleObservations: ["rules-storage-verbs-umbrella-granular"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.rule-kind.allow-read","storage.rule-kind.allow-write","storage.rule-kind.allow-get","storage.rule-kind.allow-list","storage.rule-kind.allow-create","storage.rule-kind.allow-update","storage.rule-kind.allow-delete","storage.semantic.read-umbrella","storage.semantic.write-umbrella","storage.semantic.deny-by-default"],
});
