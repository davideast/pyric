import { row } from './section.ts';

export default row({
  order: 210,
  featureKeys: ["initializeApp"],
  section: "`initializeApp` validation",
  api: "initializeApp()",
  behavior: "Without Hosting-provided defaults, omitting options throws FirebaseError code `app/no-options` with the production message",
  status: "conforms",
  evidence: "oracle: `app-registry-initializeapp-no-options` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["error-code","specific-value"],
  riskScore: 4,
  riskReasons: ["asserts Firebase error code `app/no-options`","asserts exact message text"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-initializeapp-no-options"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
