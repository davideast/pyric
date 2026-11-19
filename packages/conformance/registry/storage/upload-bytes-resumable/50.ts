import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "`task.cancel()` rejects the upload with `storage/canceled`",
  evidence: "`oracle:storage-uploadbytesresumable-progress-and-controls` (`cancelReturnedTrue: true`, `taskErrorCode: 'storage/canceled'`, `observerErrorCode: 'storage/canceled'`, `completeCalledOnCancel: false`, `postCancelGetMetadataCode: 'storage/object-not-found'`), replayed across all three planes alongside rollback suites (`#1157`, `#1159`, `#1161`).",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/canceled`"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-resumable-metadata-parity.test.ts","packages/pyric/test/storage/resumable-upload.test.ts","packages/pyric/test/storage/resumable-cancel-rollback.test.ts","packages/cli/test/serve/worker/storage-cancel-parity.test.ts","packages/cli/test/serve/worker/storage-ops.test.ts","packages/cli/test/serve/worker/storage-upload-rollback.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","test/apps/client-sdk-under-register/scenario.ts","test/apps/inpage-storage-cancel-rollback/scenario.ts"],
});
