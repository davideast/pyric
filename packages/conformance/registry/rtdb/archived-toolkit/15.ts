import { row } from './section.ts';

export default row({
  order: 50,
  api: "Removed data handler",
  behavior: "Historical rules-denied read behavior for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-rules-denied-error-code"],
  exceptionReason: "The production RTDB data handler was removed; the frozen observation remains for provenance.",
});
