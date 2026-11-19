import { row } from './section.ts';

export default row({
  order: 130,
  api: "Removed data handler",
  behavior: "Historical idempotent removal behavior for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-modular-remove-idempotent"],
  exceptionReason: "The production RTDB data handler was removed; the modular mirror retains its own active row.",
});
