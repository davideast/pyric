import { atomsPoliciesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["atoms","policies","compose"],
  behavior: "`policies` exports composite predicates that compose atoms: `pathOwnerOnly`, `fieldOwnerOnly`, `ownerOrNew`, `hasRole`, `isMember`, `required` (single keys in one `newData.hasChildren([...])`, each nested path such as `puck/x` in its own `newData.hasChild(...)`, joined with `&&`; every key segment must be a valid RTDB key), `transition`",
  evidence: "Oracle `rtdb-rules-policies-verdicts` (26/26 live Firebase 12.19.0 verdicts across all 7 `policies` helpers) replayed across `simulateRtdbRules`, sandbox, SharedWorker, and Node host; `unit:constraints/policies.test.ts`.",
  oracleObservations: ["rtdb-rules-policies-verdicts"],
  conformanceTests: ["packages/rules/test/rtdb/constraints/policies.test.ts", ...atomsPoliciesCaptureTests],
});
