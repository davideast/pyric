import { row } from './section.ts';

export default row({
  order: 70,
  api: "Removed data handler",
  behavior: "Historical set-null removal behavior for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-remove-vs-set-null"],
  exceptionReason: "The production RTDB data handler was removed; the frozen observation remains for provenance.",
});
