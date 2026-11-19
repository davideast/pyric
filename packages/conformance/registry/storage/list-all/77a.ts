import { row } from './section.ts';

export default row({
  order: 110,
  behavior: "`listAll` enforces rules: `read` permission on the scanned prefix path governs list (Firebase: `read` covers download AND list), denied prefix → `storage/unauthorized`",
  evidence: "`oracle:storage-listall-rules-enforcement` (authenticated `read` grant allows `listAll`; path outside grant and signed-out caller both reject with `FirebaseError` `storage/unauthorized`), replayed across `oracle-conformance.test.ts`, `storage-listall-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","error-code","specific-field","rules-denial"],
  riskScore: 8,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/unauthorized`","asserts a specific field/property value","asserts rules-denial behavior"],
  oracleObservations: ["storage-listall-rules-enforcement"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-listall-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric/test/storage/list-rules.test.ts"],
  rowNumber: 77,
});
