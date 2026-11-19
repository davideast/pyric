import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["denyByDefault"],
  behavior: "Literal `.read`/`.write: false`: the deny-all baseline denies every op, authed or anonymous, read or write, and a request no `.read` or `.write` rule on its path grants is denied, including where the deepest rules node on the path has only children, only a `.validate`, or only the other operation's rule",
  evidence: "`oracle:rules-rtdb-r6-deny-everything`: production verdicts captured by deploy-observe-restore, replayed verdict-for-verdict; all 3 cases DENY in production and in the simulator. `oracle:rules-rtdb-r24-deny-without-rule` (captured 2026-09-27) deploys a subtree whose root `.read` and `.write` are false: production denies a write under a node with only a `.validate` when the room `.write` is false, a write under a node with only a `.read`, and a read and a write of a node with only children, and allows the room-granted write and reads. All 7 cases match production, and `simulate` reports each denial as DENY naming the deepest `.read` or `.write` rule on the path, the verdict the sandbox returns for the same request.",
  oracleObservations: ["rules-rtdb-r6-deny-everything", "rules-rtdb-r24-deny-without-rule"],
  conformanceTests: [
    "packages/rules/test/rtdb/rules-conformance.test.ts",
    "packages/pyric/test/rules/rtdb/simulation/handler.test.ts",
    "packages/pyric/test/rules/rtdb/simulate-sandbox-agreement.test.ts",
  ],
});
