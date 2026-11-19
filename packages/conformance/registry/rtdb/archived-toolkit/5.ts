import { row } from './section.ts';

export default row({
  order: 10,
  api: "Removed REST host",
  behavior: "Historical `.json` REST transport contract for the removed production host.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-rest-json-suffix-contract"],
  exceptionReason: "The production RTDB host was removed; the frozen observation remains for provenance.",
});
