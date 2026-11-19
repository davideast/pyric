import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["initializeApp"],
  section: "`initializeApp(config, name?)` — the app registry",
  api: "initializeApp(config)",
  behavior: "Registers the default app under the name `'[DEFAULT]'`; `getApps()` has length 1 and `getApp()` (no arg) resolves the same instance",
  status: "conforms",
  evidence: "oracle: `app-registry-initializeapp-default` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-initializeapp-default"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
