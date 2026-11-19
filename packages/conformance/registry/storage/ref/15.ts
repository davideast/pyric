import { row } from './section.ts';

export default row({
  order: 30,
  behavior: "Path normalization: leading slashes stripped (`/sessions/s1` -> `sessions/s1`)",
  evidence: "Production observation `client-storage-ref-slash-normalization` (firebase 12.19.0) records `singleLeadingSlash` and `multipleLeadingSlashes` normalizing to `sessions/s1`, and `onlySlashes` normalizing to `''`. Replayed across all three planes.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  oracleObservations: ["client-storage-ref-slash-normalization"],
});
