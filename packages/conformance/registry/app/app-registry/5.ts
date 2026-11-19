import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["getApp"],
  section: "`getApp` / `getApps` / `deleteApp` — registry accessors",
  api: "getApp()",
  behavior: "`getApp()` with no name resolves the default app instance; its name is `'[DEFAULT]'`",
  status: "conforms",
  evidence: "oracle: `app-registry-getapp-default` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-getapp-default"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
