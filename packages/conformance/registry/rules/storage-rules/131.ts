import { row } from './section.ts';

export default row({
  order: 310,
  featureKeys: ["firestore.get", "firestore.exists"],
  behavior: "Real-resource Storage-to-Firestore contract: at most two distinct document paths per evaluation with repeated-path caching; typed document data and missing-document errors; default-database-only and owning-project isolation; lazy/helper/let composition; and independence from Firestore client rules",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-21: four deploy-observe-restore captures establish the real-resource contract beyond Rules Test API mocks: `oracle:stdlib-realstorage-p3-lookup-budget-iam-enabled`, `oracle:stdlib-realstorage-p3-advanced-iam-enabled`, `oracle:stdlib-realstorage-p3-named-database`, and `oracle:stdlib-realstorage-p3-project-isolation`. `unit:conformance/storage-stdlib-real-replay.test.ts` executes the locally decidable lookup matrices and locks reviewed reconstructions of their normalized probe code; the lock records state whether the digest covers an injected block or a canonical synthetic wrapper. The surrounding deployed base rules were not retained, so no full-source digest is claimed for these historical captures. Future rigs emit both probe-block and full deployed-rules-file digests. `unit:storage/enforce.test.ts` proves the normal enforcement seam reads only its owning sandbox and bypasses Firestore client rules. The separate consistency capture remains bounded characterization and is not promoted into a latency guarantee.",
  risk: ["rules-denial", "specific-value"],
  riskScore: 3,
  riskReasons: ["asserts rules-denial behavior", "asserts cross-service boundary values"],
  automation: "oracle-backed",
  oracleObservations: [
    "stdlib-realstorage-p3-lookup-budget-iam-enabled",
    "stdlib-realstorage-p3-advanced-iam-enabled",
    "stdlib-realstorage-p3-named-database",
    "stdlib-realstorage-p3-project-isolation",
  ],
  conformanceTests: [
    "packages/conformance/test/src/storage-stdlib-real-replay.test.ts",
    "packages/pyric/test/storage/enforce.test.ts",
  ],
  constructs: [
    "storage.function.firestore.get",
    "storage.function.firestore.exists",
    "storage.operator.and",
    "storage.operator.or",
    "storage.operator.ternary",
  ],
});
