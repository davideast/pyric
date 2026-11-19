import { row } from './section.ts';

export default row({
  order: 70,
  featureKeys: ["getStorage","getStorageSandbox"],
  behavior: "`options.bucket` round-trips on metadata records; v1 has a single implicit bucket but the field is preserved",
  status: "conforms",
  evidence: "`unit:service.test.ts` (\"records the bucket value on the handle\")",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  conformanceTests: ["packages/pyric/test/storage/service.test.ts"],
});
