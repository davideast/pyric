import { row } from './section.ts';

export default row({
  order: 140,
  featureKeys: ["registerVersion"],
  section: "`FirebaseError` / `SDK_VERSION` / logger seam",
  api: "registerVersion",
  behavior: "`registerVersion(library, version)` accepts a well-formed registration and returns undefined without throwing; malformed values emit the observed warning through the app-owned logger",
  status: "conforms",
  evidence: "oracle: `app-registry-registerversion` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-registerversion"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
