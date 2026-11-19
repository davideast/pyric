import { row } from './section.ts';

export default row({
  order: 180,
  featureKeys: ["getStorage","getAuth","getFirestore","getDatabase"],
  section: "`FirebaseApp` service containers",
  api: "getAuth/getFirestore/getDatabase/getStorage(app)",
  behavior: "Equal-config named apps own distinct app-associated service handles while resolving the same configured RTDB and Storage backend locators",
  status: "conforms",
  evidence: "oracle: `app-registry-multi-app-service-containers` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-multi-app-service-containers"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
