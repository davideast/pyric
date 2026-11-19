import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["getApp"],
  section: "`getApp` / `getApps` / `deleteApp` — registry accessors",
  api: "getApp('secondary')",
  behavior: "`getApp('secondary')` resolves the named app instance; its name is `'secondary'`",
  status: "conforms",
  evidence: "oracle: `app-registry-getapp-named` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-getapp-named"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
