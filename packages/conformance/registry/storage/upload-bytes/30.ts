import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Empty `Blob.type` rewrap: when caller hint differs from `Blob.type`, the blob is re-wrapped with the caller's type (same bytes)",
  evidence: "Production observation `storage-uploadbytes-contenttype-precedence` (firebase 12.19.0) records `emptyBlobCallerHint` (`audio/wav` over `Blob.type === ''`) and `typedBlobCallerOverride` (`application/pdf` over `image/png`) preserving exact bytes `[82, 73, 70, 70]`. Replayed across all three planes.",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  oracleObservations: ["storage-uploadbytes-contenttype-precedence"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-uploadbytes-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
