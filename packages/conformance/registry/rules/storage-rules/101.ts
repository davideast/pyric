import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["evaluateStorageRules","request.resource.contentType"],
  behavior: "`evaluateStorageRules` supports `request.resource.contentType == '<mime>'` constraints",
  status: "conforms",
  evidence: "`oracle:rules-storage-request-resource-content-type-equality` (5 cases: exact match ALLOW; charset suffix, uppercase MIME, different type, and omitted contentType DENY), replayed by `unit:rules/storage/rules-oracle-conformance.test.ts` and `unit:storage/sandbox/rules-evaluator.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  oracleObservations: ["rules-storage-request-resource-content-type-equality"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/storage/sandbox/rules-evaluator.test.ts"],
});
