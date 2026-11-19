import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getStorageSandbox"],
  behavior: "`getStorageSandbox(sandbox)` wraps a bare Sandbox with an anonymous context (`auth: null`)",
  status: "conforms",
  evidence: "`unit:service.test.ts`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  conformanceTests: ["packages/pyric/test/storage/service.test.ts"],
});
