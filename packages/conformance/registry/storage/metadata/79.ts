import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["getMetadata"],
  behavior: "`getMetadata(ref)` returns the same `FullMetadata` shape `uploadBytes` produced",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/storage/storage-getmetadata-full-shape.json` + `unit:metadata.test.ts`",
  risk: ["metadata"],
  riskScore: 1,
  riskReasons: ["asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-getmetadata-full-shape"],
  conformanceTests: ["packages/pyric/test/storage/metadata.test.ts", "packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-metadata-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
});
