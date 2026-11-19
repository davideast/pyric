import { row } from './section.ts';

export default row({
  order: 90,
  behavior: "`toString()` returns `gs://<bucket>/<fullPath>`",
  evidence: "Production observation `client-storage-ref-root-and-segments` (firebase 12.19.0) records `gs://buckets-default/` at root and `gs://buckets-default/<fullPath>` at depth 1, 2, and 4. Replayed across all three planes.",
  oracleObservations: ["client-storage-ref-root-and-segments"],
});
