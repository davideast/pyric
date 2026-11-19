import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["initializeApp"],
  section: "`initializeApp(config, name?)` — the app registry",
  api: "initializeApp(config)",
  behavior: "A same-name re-initialization with a DIFFERENT config throws `FirebaseError` code `app/duplicate-app`, with the app name embedded in the message",
  status: "conforms",
  evidence: "oracle: `app-registry-initializeapp-duplicate-name` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["error-code","specific-value"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code `app/duplicate-app`","asserts the exact error message"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-initializeapp-duplicate-name"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
