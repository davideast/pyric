import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "`root` accessor returns the bucket-root ref regardless of starting depth",
  evidence: "Production observation `client-storage-ref-hierarchy-and-traversal` (firebase 12.19.0) records `rootAtDepth0`, `rootAtDepth1`, and `rootAtDepth3` all returning `{ fullPath: '', name: '', parentFullPath: null }`. Replayed across all three planes.",
  oracleObservations: ["client-storage-ref-hierarchy-and-traversal"],
});
