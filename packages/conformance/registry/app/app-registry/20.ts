import { row } from './section.ts';

export default row({
  order: 200,
  featureKeys: ["deleteApp","initializeApp"],
  section: "Documented single-backend limitation",
  api: "deleteApp(app); initializeApp(differentOptions)",
  behavior: "Production permits a different configuration after deletion; Pyric retains the runtime backend lock and rejects the reinitialization",
  status: "diverged-documented",
  evidence: "oracle: `app-registry-delete-reinitialize-different-config` (firebase 12.19.0) + replay pins `app/multiple-configs-not-supported`",
  risk: ["error-code","structural"],
  riskScore: 3,
  riskReasons: ["valid upstream post-delete reconfiguration is rejected"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-delete-reinitialize-different-config"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
  exceptionReason: "Deleting an SDK container must not relabel or erase the shared persisted sandbox backend; the config lock therefore lasts for the runtime lifetime.",
});
