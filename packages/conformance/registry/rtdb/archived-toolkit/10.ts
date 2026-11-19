import { row } from './section.ts';

export default row({
  order: 20,
  api: "Removed data handler",
  behavior: "Historical admin read and set/get behavior for the removed production data handler.",
  evidence: "Archived oracle observations; implementation removed.",
  oracleObservations: ["rtdb-handler-admin-vs-user-returnshape","rtdb-set-then-get-roundtrip"],
  exceptionReason: "The production RTDB data handler was removed; frozen observations remain for provenance.",
});
