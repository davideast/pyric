import { atomsPoliciesCaptureTests } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["atoms"],
  behavior: "`atoms` exports the documented set of primitive predicates (`authenticated`, `ownPath`, `ownField`, `isNew`, `hasChildren`, `hasChild`, `fieldIsString/Number/Boolean`, `fieldEnum`, `immutable`, `immutableSelf`, `rootExists`, `rootEquals`) — each returns an `Expr`",
  evidence: "Oracle `rtdb-rules-atoms-verdicts` (34/34 live Firebase 12.19.0 verdicts across all 14 `atoms` predicates) replayed across `simulateRtdbRules`, sandbox, SharedWorker, and Node host; `unit:constraints/atoms.test.ts`.",
  oracleObservations: ["rtdb-rules-atoms-verdicts"],
  conformanceTests: ["packages/rules/test/rtdb/constraints/atoms.test.ts", ...atomsPoliciesCaptureTests],
});
