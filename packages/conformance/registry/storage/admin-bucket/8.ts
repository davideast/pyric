import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["Bucket.deleteFiles"],
  api: "bucket.deleteFiles({ prefix, force })",
  behavior: "Deletes every file `getFiles` would list across its pages, up to `maxResults`, ten at a time, and leaves the others. Without `force` the first failed delete rejects the call; with `force` every file is tried and the call rejects with the array of errors",
  status: "conforms",
  oracleObservations: ["admin-storage-bucket-deletefiles"],
  evidence: "Replayed on the in-process arm, a SharedWorker host (`oracle-conformance.test.ts`), and the Node host (`hosted-sqlite.test.ts`) against production observation `admin-storage-bucket-deletefiles` (firebase-admin 13.10.0: `cappedMaxResults2` `seededCount: 3`, `remainingRelativeNames: ['capped/c.bin']`, `siblingStillExists: true`; `fullPrefixDelete` `remainingRelativeNames: []`, `siblingStillExists: true`; `emptyPrefixDelete.threw: false`). `bucket-listing.test.ts` pins `force` error aggregation, `bucket-files.test.ts` pins bucket isolation, and `test/apps/admin-storage-delete-prefix` drives it under `pyric sandbox --hosted`.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts which objects remain"],
});
