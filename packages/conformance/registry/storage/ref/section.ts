import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 20,
  defaults: {
    featureKeys: ["ref"],
    section: "`ref(storage[, path])` / `ref(parent, path)` — reference constructor",
    api: "ref(storage[, path])` / `ref(parent, path)",
    status: "conforms",
    automation: "oracle-backed",
    conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-ref-properties.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
  },
});

export const row = section.row;
