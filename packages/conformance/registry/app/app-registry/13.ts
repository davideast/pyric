import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["onLog","setLogLevel"],
  section: "`FirebaseError` / `SDK_VERSION` / logger seam",
  api: "onLog / setLogLevel",
  behavior: "`onLog(cb)` / `setLogLevel(level)` are a functioning app-owned diagnostic-logger seam: registering a handler returns undefined, raising the threshold takes effect, and a malformed `registerVersion` emits a `warn` entry (type `@firebase/app`) to the handler",
  status: "conforms",
  evidence: "oracle: `app-registry-onlog-setloglevel` (firebase 12.19.0) + replay: `oracle-conformance.test.ts`",
  risk: ["structural"],
  automation: "oracle-backed",
  oracleObservations: ["app-registry-onlog-setloglevel"],
  conformanceTests: ["packages/pyric/test/app/oracle-conformance.test.ts"],
  notes: "The sandbox logger is process-local and independent from Firebase. Package resolution ensures production code receives the real Firebase logger, while the mirror reproduces the observed register, threshold, and emission contract without a production runtime dependency.",
});
