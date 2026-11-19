import { row } from './section.ts';

export default row({
  order: 250,
  featureKeys: ["parseStorageRules", "evaluateStorageRules", "request.auth"],
  behavior: "`2+modules` Storage rules resolve through service-aware contracts: the common `auth` and `membership` exports are admitted and retain their production auth, claim, map-membership, and role semantics; Firestore-only helpers are rejected before evaluation",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-20; paired proof added 2026-07-21: one targeted production Rules Test API capture proves the exact six bundled function bodies (`isAuthenticated`, `isOwner`, `hasClaim`, `hasClaimRole`, `isMemberOf`, `hasRole`) under `firebase.storage`, matching the local evaluator verdict-for-verdict on 12 allow/deny cases. `oracle:rules-storage-common-auth-membership` supplies the Storage answer key; Firestore Rules row #189 independently captures the same exact bodies under `cloud.firestore` (12 matching verdicts). A separately authored, explicitly reconstructed normalized-AST digest locks the captured Storage corpus bodies, and the source-lock test requires the Firestore corpus and shipped modules to remain AST-identical. Resolver tests separately prove `2+modules` lowers these imports to plain v2 and fails closed with `INCOMPATIBLE_FUNCTION` for a Firestore-only export and for a transitive helper that reads `resource.data`; the Storage service integration test proves normal setup invokes that checked resolver.",
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-common-auth-membership"],
  conformanceTests: [
    "packages/conformance/test/src/storage-stdlib-source-lock.test.ts",
    "packages/rules/test/storage/rules-oracle-conformance.test.ts",
    "packages/rules/test/modules/resolver.test.ts",
    "packages/pyric/test/storage/enforce.test.ts",
  ],
  constructs: [
    "storage.binding.request.auth",
    "storage.binding.request.auth.uid",
    "storage.binding.request.auth.token",
    "storage.operator.in",
    "storage.rule-kind.function",
  ],
});
