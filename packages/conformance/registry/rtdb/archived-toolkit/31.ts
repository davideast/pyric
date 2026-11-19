import { row } from './section.ts';

export default row({
  order: 120,
  api: "Removed data handler",
  behavior: "Historical remove-versus-set-null behavior for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-remove-vs-set-null"],
  exceptionReason: "The production RTDB data handler was removed; the modular mirror retains its own active row.",
});
