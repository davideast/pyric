import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Honors `maxDownloadSize` same as `getBytes`",
  evidence: "`unit:upstream-storage-probes.test.ts` (\"getBytes / getBlob return a truncated prefix when the object exceeds the cap\"; shared `fetchBlob` helper in `download.ts`)",
  automation: "unit-backed",
  conformanceTests: ["packages/pyric/test/storage/upstream-storage-probes.test.ts"],
});
