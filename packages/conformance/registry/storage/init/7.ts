import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["getStorage","getStorageSandbox"],
  behavior: "`options.dbName` honored on the FIRST call per `Sandbox`; second-call overrides ignored",
  status: "conforms",
  evidence: "`unit:service.test.ts` (\"dbName only takes effect on the sandbox's first getStorage call\")",
  conformanceTests: ["packages/pyric/test/storage/service.test.ts"],
});
