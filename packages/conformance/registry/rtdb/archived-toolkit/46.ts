import { row } from './section.ts';

export default row({
  order: 150,
  api: "Removed rules deployment handler",
  behavior: "Historical rules deployment propagation timing for the removed production deploy handler.",
  evidence: "Archived oracle observation; implementation removed.",
  oracleObservations: ["rtdb-rules-deploy-propagation-timing"],
  exceptionReason: "The production RTDB rules deployment handler was removed; the frozen observation remains for provenance.",
});
