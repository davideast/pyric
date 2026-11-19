import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "`parent` chain walks back to root (each `.parent` strips one segment until empty, then `null`)",
  evidence: "Production observation `client-storage-ref-hierarchy-and-traversal` (firebase 12.19.0) records `parentChainFromDepth3` (`alpha/beta/gamma` -> `alpha/beta` -> `alpha` -> `''`) and `terminalParentIsNull: true`. Replayed across all three planes.",
  oracleObservations: ["client-storage-ref-hierarchy-and-traversal"],
});
