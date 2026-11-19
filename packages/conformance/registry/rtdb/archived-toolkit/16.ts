import { row } from './section.ts';

export default row({
  order: 60,
  api: "Removed data handler",
  behavior: "Historical set/get round trip for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-set-then-get-roundtrip"],
  exceptionReason: "The production RTDB data handler was removed; the frozen observation remains for provenance.",
});
