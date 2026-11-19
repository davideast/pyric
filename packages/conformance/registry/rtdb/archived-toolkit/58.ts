import { row } from './section.ts';

export default row({
  order: 160,
  api: "Removed REST crawler",
  behavior: "Historical shallow REST response shape for the removed production crawler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-shallow-rest-response-shape"],
  exceptionReason: "The production RTDB REST crawler was removed; the frozen observation remains for provenance.",
});
