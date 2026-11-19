import { row } from './section.ts';

export default row({
  order: 140,
  api: "Removed rules fetch handler",
  behavior: "Historical deployed-rules JSON round trip for the removed production fetch handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-rules-json-roundtrip"],
  exceptionReason: "The production RTDB rules fetch handler was removed; the frozen observation remains for provenance.",
});
