import { row } from './section.ts';

export default row({
  order: 90,
  api: "Removed data handler",
  behavior: "Historical multi-path update behavior for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-modular-update-multipath-atomic"],
  exceptionReason: "The production RTDB data handler was removed; the modular mirror retains its own active row.",
});
