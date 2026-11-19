import { row } from './section.ts';

export default row({
  order: 170,
  featureKeys: ["request.resource","resource","request.method","request.path"],
  behavior: "`request.resource.size` arithmetic bounds (`+`/`-`/`*`/`/`, `>=`/`<=`), request/existing content-type and custom `metadata` checks, `request.method`/`request.path`, a `request.auth.token` custom-claim branch, granular `allow list`, and a recursive `{allPaths=**}` public read tree",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-12: production capture proves the evaluator matches the production Storage Rules Test API verdict-for-verdict on all 8 cases (owner-scoped size-bounded upload, immutable-content-type update, list grant, public recursive read). `oracle:rules-storage-metadata-verbs-and-arithmetic` — replayed by `packages/rules/test/storage/rules-oracle-conformance.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-metadata-verbs-and-arithmetic"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
});
