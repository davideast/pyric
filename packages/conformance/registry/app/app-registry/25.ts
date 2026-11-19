import { row } from './section.ts';

export default row({
  order: 250,
  featureKeys: ["deleteApp","getAI","getAuth","getFirestore","getDatabase","getStorage"],
  section: "`FirebaseApp` deletion lifecycle",
  api: "deleteApp(app); getAuth/getFirestore/getDatabase/getStorage/getAI(app)",
  behavior: "After deletion, fresh Auth/Firestore/RTDB/Storage factories reject; cached factories return retained handles; retained Auth sign-out resolves but a new anonymous sign-in rejects `app/app-deleted`; Firestore reads report termination, RTDB refuses new refs, Storage refs remain constructible, and `getAI(deletedApp)` returns an app-associated handle",
  status: "conforms",
  evidence: "oracles: `app-registry-deleted-service-factories` and real-Chromium `app-production-multi-app-topology` (firebase 12.19.0) + replays: `oracle-conformance.test.ts`, `deleted-service-lifecycle.test.ts`, and `production-multi-app-oracle.test.ts`",
  risk: ["error-code","structural"],
  riskScore: 3,
  riskReasons: ["asserts deleted-container and retained-handle behavior across five service families"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-deleted-service-factories","app-production-multi-app-topology"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts","packages/pyric/test/app/deleted-service-lifecycle.test.ts","packages/pyric/test/app/production-multi-app-oracle.test.ts"],
});
