import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["initializeApp"],
  section: "`initializeApp(config, name?)` — the app registry",
  api: "initializeApp(config, 'secondary')",
  behavior: "Registers a named app alongside the default; `getApp('secondary')` resolves it and `getApps()` has length 2 (default + named)",
  status: "conforms",
  evidence: "oracle: `app-registry-initializeapp-named` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-initializeapp-named"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
