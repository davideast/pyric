import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["initializeApp"],
  section: "`initializeApp(config, name?)` — the app registry",
  api: "initializeApp(config)",
  behavior: "A same-name re-initialization with EQUAL config is idempotent — no throw, returns the existing instance, and `getApps()` stays length 1",
  status: "conforms",
  evidence: "oracle: `app-registry-initializeapp-duplicate-config` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-initializeapp-duplicate-config"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
