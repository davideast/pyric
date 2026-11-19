import { row } from './section.ts';

export default row({
  order: 190,
  featureKeys: ["initializeApp"],
  section: "Documented single-backend limitation",
  api: "initializeApp(differentOptions, 'secondary')",
  behavior: "Production permits a differently configured named app; Pyric rejects it because one runtime currently owns exactly one sandbox backend",
  status: "diverged-documented",
  evidence: "oracle: `app-registry-initializeapp-named-different-config` (firebase 12.19.0) + replay pins `app/multiple-configs-not-supported`; `packages/cli/test/e2e/app-multi-app.pw.ts` proves the same lock is enforced by the authoritative SharedWorker across same-origin tabs, not only by one page registry",
  risk: ["error-code","structural"],
  riskScore: 3,
  riskReasons: ["valid upstream multi-backend initialization is rejected"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-initializeapp-named-different-config"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts","packages/cli/test/e2e/app-multi-app.pw.ts"],
  exceptionReason: "The initial mirror supports one FirebaseOptions value and one sandbox backend per runtime; accepting and silently misrouting a second config would be less trustworthy than an explicit error.",
});
