import { row } from './section.ts';

export default row({
  order: 510,
  featureKeys: ["get","set"],
  behavior: "Rules-denied transaction rejects with a plain `Error` whose `message === 'permission_denied'` (lowercase) and NO `.code` field -- DIFFERENT from `set`/`get`'s `'PERMISSION_DENIED: Permission denied'` shape with uppercase `.code`.",
  status: "conforms",
  evidence: "Sandbox aligned: `unit:modular/transaction.test.ts` (\"rejects with a plain Error whose message is \\\"permission_denied\\\"\"); matches oracle observation `packages/conformance/observations/rtdb-modular/rtdb-modular-runtransaction-on-rules-denied-path.json` (against digame-mas: `message: 'permission_denied', code: null, constructorName: 'Error'`). The served page receives the same codeless Error through the worker protocol (`packages/cli/test/serve/worker/rtdb-denial-context.test.ts`).",
  risk: ["specific-value","specific-field","atomicity","rules-denial"],
  riskScore: 7,
  riskReasons: ["asserts 1 specific value(s)","asserts a specific field/property value","asserts transaction/batch atomicity","asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-on-rules-denied-path"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction.test.ts", "packages/pyric/test/database/denial-context.test.ts", "packages/cli/test/serve/worker/rtdb-denial-context.test.ts"],
  rowNumber: 37,
});
