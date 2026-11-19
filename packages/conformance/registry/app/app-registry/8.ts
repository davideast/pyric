import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["getApps"],
  section: "`getApp` / `getApps` / `deleteApp` — registry accessors",
  api: "getApps()",
  behavior: "`getApps()` returns an array containing every registered app by identity (the exact instances, not copies)",
  status: "conforms",
  evidence: "oracle: `app-registry-getapps-contents` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-getapps-contents"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
