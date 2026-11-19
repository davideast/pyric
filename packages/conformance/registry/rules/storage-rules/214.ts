import { row } from './section.ts';

export default row({
  order: 520,
  featureKeys: ["parseStorageRules"],
  behavior: "`service cloud.storage`, the spelling in the documented v2 snippet, is accepted beside `service firebase.storage` (ST-H1-14)",
  status: "conforms",
  automation: "oracle-backed",
  evidence: "`oracle:rules-storage-h1-deploy-cloud-storage-service` (captured 2026-10-27, 1 case) records production compiling a `service cloud.storage` ruleset and ALLOWING its read. `parseStorageRules` accepts `service cloud.storage` alongside `service firebase.storage` and agrees.",
  risk: ["rules-denial"],
  riskScore: 1,
  riskReasons: ["pyric refuses a ruleset production deploys"],
  oracleObservations: ["rules-storage-h1-deploy-cloud-storage-service"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.rule-kind.match"],
});
