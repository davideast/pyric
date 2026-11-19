import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["getStorage","getStorageSandbox"],
  behavior: "Two different `SandboxContext`s on the same `Sandbox` get DIFFERENT handles but share the underlying `StorageService` (IDB)",
  status: "conforms",
  evidence: "`unit:service.test.ts` (\"shares the underlying StorageService across contexts on the same sandbox\")",
  conformanceTests: ["packages/pyric/test/storage/service.test.ts"],
});
