import { row } from './section.ts';

export default row({
  order: 170,
  featureKeys: ["initializeApp"],
  section: "`FirebaseApp` container shape",
  api: "initializeApp(equalOptions, 'secondary')",
  behavior: "Equal-config named apps are distinct app containers with equal option values and independent name-keyed registry identity",
  status: "conforms",
  evidence: "oracle: `app-registry-initializeapp-named-equal-config` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-initializeapp-named-equal-config"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
});
