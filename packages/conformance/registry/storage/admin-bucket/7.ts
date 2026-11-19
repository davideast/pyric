import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["Bucket.getFiles"],
  api: "bucket.getFiles({ prefix, delimiter, maxResults, pageToken, autoPaginate })",
  behavior: "Lists the files whose names start with `prefix`, in name order, as `[files, nextQuery, apiResponse]`. Each returned `File` has `file.metadata` populated, and `apiResponse.items` holds the final page's object metadata when that page listed at least one file. `delimiter` rolls names up into `apiResponse.prefixes`. `maxResults` or `autoPaginate: false` gives one page and the next page's query, or `null` on the last page; reading every page gives the call's own query in that position",
  status: "conforms",
  oracleObservations: ["admin-storage-bucket-getfiles"],
  evidence: "Replayed on the in-process arm, a SharedWorker host (`oracle-conformance.test.ts`), and the Node host (`hosted-sqlite.test.ts`) against production observation `admin-storage-bucket-getfiles` (firebase-admin 13.10.0: `partialFolderPrefix`, `slashFolderPrefix`, `delimiterRollup`, and two-page `paginated` queries all match verbatim, including `apiResponseHasItemsProperty: true` and `firstFileMetadataPopulated: true`). Also covered by `bucket-listing.test.ts`, `bucket-files.test.ts`, `test/apps/admin-storage-delete-prefix`, and `test/apps/admin-storage-list-wide-tree`.",
  risk: ["specific-value", "metadata"],
  riskScore: 3,
  riskReasons: ["asserts specific listing values", "asserts metadata shape"],
});
