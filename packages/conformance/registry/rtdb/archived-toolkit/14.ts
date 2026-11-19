import { row } from './section.ts';

export default row({
  order: 40,
  api: "Removed data handler",
  behavior: "Historical rules-denial normalization for the removed production data handler.",
  evidence: "Archived oracle observations; implementation removed.",
  oracleObservations: ["rtdb-rules-denied-error-code","rtdb-modular-runtransaction-on-rules-denied-path"],
  exceptionReason: "The production RTDB data handler was removed; frozen observations remain for provenance.",
});
