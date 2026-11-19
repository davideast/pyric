import { row } from './section.ts';

export default row({
  order: 110,
  behavior: "References are mirror-owned value objects; `parent` and `root` preserve the same storage handle and path semantics",
  evidence: "Production observation `client-storage-ref-identity-and-storage-handle` (firebase 12.19.0) records `directPreservesStorageHandle: true`, `parentPreservesStorageHandle: true`, `rootPreservesStorageHandle: true`, `childJoinPreservesStorageHandle: true`, and `bucketPreservedAcrossChain: true`. Replayed across all three planes.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  oracleObservations: ["client-storage-ref-identity-and-storage-handle"],
});
