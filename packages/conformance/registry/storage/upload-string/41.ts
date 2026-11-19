import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "`format='base64url'`: decodes URL-safe base64 (padded or unpadded); an unrecognized format synchronously throws `storage/unknown`",
  status: "conforms",
  evidence: "`oracle:storage-uploadstring-base64url-roundtrip` (`unpaddedUrlSafe`: `'-_8BAg'` -> `[251, 255, 1, 2]`, `paddedUrlSafe`: `'-_8='` -> `[251, 255]`, `unknownFormat`: `threwSynchronously: true`, `code: 'storage/unknown'`) and `oracle:storage-uploadstring-unknown-format`, replayed across `oracle-conformance.test.ts`, `storage-resumable-metadata-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","error-code","specific-field"],
  riskScore: 6,
  riskReasons: ["asserts decoded URL-safe base64 bytes","asserts Firebase error code(s): `storage/unknown`","asserts synchronous throw timing"],
  automation: "oracle-backed",
  oracleObservations: ["storage-uploadstring-base64url-roundtrip","storage-uploadstring-unknown-format"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-resumable-metadata-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/error-codes.test.ts"],
});
