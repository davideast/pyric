import { defineRowSection } from '../../section-rows.ts';

// The admin plane: born unverified, flipped only by its conformance suite.
export const section = defineRowSection({
  surface: "storage-admin",
  order: 160,
  prefix: "## `pyric-admin/storage`: `File` metadata and download URLs\n\nThe admin plane (surface `storage-admin`), climbing under CDD. Each row cites the production capture `admin-storage-metadata-download-url` (firebase-admin 13.10.0) and is replayed by the pyric-admin conformance suite on the in-process arm and on a SharedWorker host, and by the hosted replay on the Node host.\n",
  defaults: {
    section: "`pyric-admin/storage`: `File` metadata and download URLs",
    status: "unverified",
    automation: "unverified",
    oracleObservations: ["admin-storage-metadata-download-url"],
    conformanceTests: ["packages/pyric-admin/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
  },
});

export const row = section.row;
