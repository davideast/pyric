import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["pathVariables","auth.uid"],
  behavior: "`$uid` path-variable ownership (`$uid === auth.uid`) — the owner path allows, a foreign uid and an anonymous request deny",
  evidence: "`oracle:rules-rtdb-r2-own-uid`: production verdicts captured by deploy-observe-restore, replayed verdict-for-verdict against the in-process simulator; all 5 cases match production, so the simulator binds the path variable against `auth.uid` exactly as production does. `oracle:rules-rtdb-r22-strict-equality-types` (captured 2026-09-27) deploys the same ownership rule as `$uid === auth.uid` and a `$name !== 'nobody'` key guard: production allows the owner read and write, denies a foreign uid and an anonymous read, and denies the sentinel key. It also records strict typing: `newData.val() === 5` denies the string `'5'`, and `newData.val() !== '5'` allows the number 5. The expression grammar parses `===` and `!==`, the simulator evaluates them without type conversion, and all 11 cases match production.",
  oracleObservations: ["rules-rtdb-r2-own-uid", "rules-rtdb-r22-strict-equality-types"],
  conformanceTests: [
    "packages/rules/test/rtdb/rules-conformance.test.ts",
    "packages/rules/test/rtdb/grammar/RtdbExprParser.test.ts",
    "packages/rules/test/rtdb/grammar/simulator.test.ts",
    "packages/pyric/test/database/sandbox-controls.test.ts",
  ],
});
