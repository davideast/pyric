import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getStorage"],
  behavior: "`getStorage(app)` returns the sandbox handle selected by package resolution",
  status: "conforms",
  evidence: "`oracle:storage-getstorage-handle-and-md5` (`sameAppIdentityStable: true`, `differentAppDistinctHandle: true`, `appPropertyMatches: true`, `maxOperationRetryTime: 120000 -> 45000`, `maxUploadRetryTime: 600000 -> 180000`, plus round-trip `uploadBytes` + `getBytes`) + `entry-path:storage`, replayed across `oracle-conformance.test.ts`, `storage-resumable-metadata-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["structural"],
  riskReasons: ["structural / routing-only claim"],
  automation: "oracle-backed",
  oracleObservations: ["storage-getstorage-handle-and-md5"],
  conformanceTests: ["packages/conformance/entry-path/storage.ts","packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-resumable-metadata-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts"],
});
