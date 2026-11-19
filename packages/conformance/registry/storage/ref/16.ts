import { row } from './section.ts';

export default row({
  order: 40,
  behavior: "Path normalization: trailing slashes stripped",
  evidence: "Production observation `client-storage-ref-slash-normalization` (firebase 12.19.0) records `singleTrailingSlash` and `multipleTrailingSlashes` normalizing to `sessions/s1`. Replayed across all three planes.",
  oracleObservations: ["client-storage-ref-slash-normalization"],
});
