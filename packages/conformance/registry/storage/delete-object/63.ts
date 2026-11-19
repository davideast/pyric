import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "Removes both the blob AND the metadata atomically (post-delete `getBlob` throws `object-not-found`)",
  status: "conforms",
  evidence: "`oracle:storage-deleteobject-removes-bytes-and-metadata` (`deleteResolvedUndefined: true`, post-delete `getBytes` and `getMetadata` throw `storage/object-not-found`), replayed across `oracle-conformance.test.ts`, `storage-delete-listall-rules-parity.test.ts`, and `hosted-sqlite.test.ts`",
  risk: ["specific-value","error-code","sentinel","atomicity","metadata"],
  riskScore: 10,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `object-not-found`","asserts sentinel or atomic transform semantics","asserts transaction/batch atomicity","asserts metadata shape"],
  automation: "oracle-backed",
  oracleObservations: ["storage-deleteobject-removes-bytes-and-metadata"],
  conformanceTests: ["packages/pyric/test/storage/oracle-conformance.test.ts","packages/cli/test/serve/worker/storage-delete-listall-rules-parity.test.ts","packages/cli/test/serve/hosted-sqlite.test.ts","packages/pyric/test/storage/reference.test.ts"],
});
