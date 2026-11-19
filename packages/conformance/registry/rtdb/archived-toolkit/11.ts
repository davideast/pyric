import { row } from './section.ts';

export default row({
  order: 30,
  api: "Removed data handler",
  behavior: "Historical user read return shape for the removed production data handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-handler-admin-vs-user-returnshape"],
  exceptionReason: "The production RTDB data handler was removed; the frozen observation remains for provenance.",
});
