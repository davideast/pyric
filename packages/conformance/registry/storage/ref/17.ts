import { row } from './section.ts';

export default row({
  order: 50,
  behavior: "Path normalization: repeated internal slashes collapsed (`a//b` -> `a/b`)",
  evidence: "Production observation `client-storage-ref-slash-normalization` (firebase 12.19.0) records `repeatedInternalSlashes` (`a/b`), `manyInternalSlashes` (`a/b/c`), and `combinedSlashes` (`a/b/c`). Replayed across all three planes.",
  risk: ["specific-value"],
  riskScore: 2,
  riskReasons: ["asserts 1 specific value(s)"],
  oracleObservations: ["client-storage-ref-slash-normalization"],
});
