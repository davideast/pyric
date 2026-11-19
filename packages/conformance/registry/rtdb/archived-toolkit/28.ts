import { row } from './section.ts';

export default row({
  order: 110,
  api: "Removed data handler",
  behavior: "Historical push auto-ID format for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-push-autoid-format"],
  exceptionReason: "The production RTDB data handler was removed; the modular mirror retains its own active row.",
});
