import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 50,
  defaults: {
    featureKeys: ["uploadBytesResumable"],
    section: "`uploadBytesResumable(ref, data, metadata?)` — resumable upload + task observers",
    api: "uploadBytesResumable(ref, data, metadata?)",
    status: "conforms",
    automation: "oracle-backed",
    oracleObservations: ["storage-uploadbytesresumable-progress-and-controls"],
    conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-resumable-metadata-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/resumable-upload.test.ts"],
  },
});

export const row = section.row;
