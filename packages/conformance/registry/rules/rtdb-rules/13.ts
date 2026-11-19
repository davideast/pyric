import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["getPriority","indexOn"],
  behavior: "`getPriority()` on a plain `set` (an unset priority reads null) and the `.indexOn` query-planner directive",
  evidence: "NEW ROW, 2026-07-12: production capture proves a plain `set` leaves a node's priority unset, so `getPriority()` reports null in production exactly as the simulator does, and that a ruleset carrying `.indexOn` deploys and evaluates with every verdict intact. The scope is exactly that: `.indexOn` never changes an allow/deny verdict, so the twin evidences only that production's compiler accepts and deploys the directive, and it says nothing about query behavior. Non-null priorities are verified separately by row #20, whose capture seeds them through the admin adapter and writes one in a `{ .value, .priority }` value. `oracle:rules-rtdb-r13-priority-and-index-directive` matches production verdict-for-verdict on all 4 cases.",
  oracleObservations: ["rules-rtdb-r13-priority-and-index-directive"],
});
