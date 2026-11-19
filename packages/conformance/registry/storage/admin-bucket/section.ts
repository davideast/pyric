import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage-admin",
  order: 170,
  prefix: "## `pyric-admin/storage`: `Bucket` listing and prefix delete\n\nThe admin plane (surface `storage-admin`). firebase-admin's `Bucket.getFiles` and `Bucket.deleteFiles`, as a backend calls them to clean up an entity's objects under a prefix. Each row cites its production capture (`admin-storage-bucket-getfiles`, `admin-storage-bucket-deletefiles`; firebase-admin 13.10.0) and is replayed across the in-process arm, a SharedWorker host, and the Node host.\n",
  defaults: { section: "`pyric-admin/storage`: `Bucket` listing and prefix delete", automation: "oracle-backed", conformanceTests: ["packages/pyric-admin/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts", "packages/pyric-admin/test/storage/bucket-files.test.ts", "packages/pyric-admin/test/storage/bucket-listing.test.ts", "test/apps/admin-storage-delete-prefix/scenario.ts"] },
});

export const row = section.row;
