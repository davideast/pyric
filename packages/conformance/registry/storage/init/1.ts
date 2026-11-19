import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getStorageSandbox"],
  behavior: "`getStorageSandbox(ctx)` returns a tagged sandbox-target handle (frozen identity)",
  status: "conforms",
  evidence: "`unit:service.test.ts`",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  conformanceTests: ["packages/pyric/test/storage/service.test.ts"],
});
