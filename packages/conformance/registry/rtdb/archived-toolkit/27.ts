import { row } from './section.ts';

export default row({
  order: 100,
  api: "Removed data handler",
  behavior: "Historical push key behavior for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-push-autoid-format"],
  exceptionReason: "The production RTDB data handler was removed; the modular mirror retains its own active row.",
});
