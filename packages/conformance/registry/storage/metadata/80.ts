import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["getMetadata"],
  behavior: "`getMetadata(ref)` throws `storage/object-not-found` for missing paths",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/storage/storage-metadata-missing-object-errors.json` + `unit:metadata.test.ts`",
  risk: ["specific-value","error-code","metadata"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/object-not-found`","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-metadata-missing-object-errors"],
  conformanceTests: ["packages/pyric/test/storage/metadata.test.ts", "packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-metadata-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
});
