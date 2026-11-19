import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["getMetadata"],
  behavior: "`getMetadata(ref)` synchronously throws `storage/invalid-root-operation` on the root",
  status: "conforms",
  evidence: "oracle: `packages/conformance/observations/storage/client-storage-getmetadata-root-ref.json` + `unit:metadata.test.ts`",
  risk: ["specific-value","error-code","metadata"],
  riskScore: 6,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `storage/invalid-root-operation`","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["client-storage-getmetadata-root-ref"],
  conformanceTests: ["packages/pyric/test/storage/metadata.test.ts", "packages/pyric/test/storage/oracle-conformance.test.ts", "packages/cli/test/serve/worker/storage-metadata-parity.test.ts", "packages/cli/test/serve/hosted-sqlite.test.ts"],
});
