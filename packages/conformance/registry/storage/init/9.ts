import { row } from './section.ts';

export default row({
  order: 100,
  featureKeys: ["getStorage","getStorageSandbox"],
  behavior: "The `TARGET_SYMBOL` brand keeps each handle bound to its owning sandbox service and identity",
  status: "conforms",
  evidence: "`unit:service.test.ts` (distinct contexts share one service while retaining distinct handles)",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  conformanceTests: ["packages/pyric/test/storage/service.test.ts"],
  exceptionReason: "sandbox-only behavior — no prod equivalent to observe",
});
