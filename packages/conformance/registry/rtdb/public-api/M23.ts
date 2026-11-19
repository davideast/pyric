import { row } from './section.ts';

export default row({
  order: 240,
  featureKeys: ["set"],
  behavior: "Rules-denied write throws a plain `Error` (NOT a `FirebaseError`) with `.code === 'PERMISSION_DENIED'` (uppercase snake-case) and `.message === 'PERMISSION_DENIED: Permission denied'`",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/sandbox-target.test.ts` (\"rules-denied set throws a plain Error with PERMISSION_DENIED code\"); matches oracle observation `packages/conformance/observations/rtdb/rtdb-rules-denied-error-code.json` (against digame-mas, fb-js-sdk 12.19.0). The sandbox adds an own enumerable `denialContext` (engine `rtdb`, the deciding rule, bindings and request) to the same plain `Error`; `unit:denial-context.test.ts` asserts class, name, code and message are unchanged for every denied operation, and the worker bridge test asserts served pages receive the context.",
  risk: ["specific-field","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts a specific field/property value","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-denied-error-code"],
  conformanceTests: ["packages/pyric/test/database/modular/sandbox-target.test.ts", "packages/pyric/test/database/denial-context.test.ts", "packages/cli/test/serve/worker/rtdb-denial-context.test.ts"],
  rowNumber: 23,
});
