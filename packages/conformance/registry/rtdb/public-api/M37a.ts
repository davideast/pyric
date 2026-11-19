import { row } from './section.ts';

export default row({
  order: 470,
  featureKeys: ["update"],
  behavior: "Returning `undefined` from the update fn ABORTS the transaction -- resolves `{ committed: false, snapshot }`; no write performed, no listener fan-out",
  status: "conforms",
  evidence: "Oracle `rtdb-modular-runtransaction-abort-undefined` records `committed === false`, `snapVal: null` on a cold handle, and unchanged server data (`afterValOnServer: 100`), replayed on both warm single-handle and cold secondary-handle clients in `unit:modular/oracle-conformance-transactions.test.ts` alongside `unit:modular/transaction.test.ts`.",
  risk: ["specific-field","listener","atomicity"],
  riskScore: 5,
  riskReasons: ["asserts a specific field/property value","asserts listener semantics","asserts transaction/batch atomicity"],
  automation: "oracle-backed",
  oracleObservations: ["rtdb-modular-runtransaction-abort-undefined"],
  conformanceTests: ["packages/pyric/test/database/modular/transaction.test.ts","packages/pyric/test/database/modular/oracle-conformance-transactions.test.ts"],
  rowNumber: 37,
});
