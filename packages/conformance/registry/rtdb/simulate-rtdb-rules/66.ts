import { atomsPoliciesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "Cross-path `root.child(...).val()` and `exists()` reads resolve stored values across `mockData` (and atomic multi-path write projections) and return `null` (`false`) for absent paths, matching production RTDB across `simulateRtdbRules` and live sandboxes",
  status: "conforms",
  evidence: "Oracles `rtdb-rules-atoms-verdicts` (`crossPathRootLookups`: `rootExists`, `rootEquals`) and `rtdb-rules-policies-verdicts` (`hasRole`, `isMember`) record populated and absent cross-tree `root.child(...)` verdicts; replayed across `simulateRtdbRules`, sandbox, SharedWorker, and Node host alongside `unit:simulation/handler.test.ts`.",
  automation: "oracle-backed",
  oracleObservations: ["rtdb-rules-atoms-verdicts", "rtdb-rules-policies-verdicts"],
  conformanceTests: ["packages/pyric/test/rules/rtdb/simulation/handler.test.ts", ...atomsPoliciesCaptureTests],
});
