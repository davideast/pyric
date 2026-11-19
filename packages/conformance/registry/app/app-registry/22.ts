import { row } from './section.ts';

export default row({
  order: 220,
  featureKeys: ["getStorage","getAuth","getFirestore","getDatabase"],
  section: "`FirebaseApp` service containers",
  api: "getAuth/getFirestore/getDatabase/getStorage()",
  behavior: "With a registered default app, each no-argument service factory resolves a service associated with that exact default app",
  status: "conforms",
  evidence: "oracle: `app-registry-default-service-factories` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-default-service-factories"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
