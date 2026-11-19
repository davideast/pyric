import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["compose"],
  behavior: "Game-domain helpers (`turnGuard`, `flip`, `winCheckHelper`) and the `rtdbStdlib` standard library modules (`validation`, `lifecycle`, `lobby`, `turns`, `results`, `counters`, `presence`, `timing`, `collections`, `auth`, `membership`) compose into legal rule expressions, and `simulate` and the sandbox decide each documented allow and deny case alike",
  evidence: "`unit:constraints/game.test.ts`. Extended 2026-10-07: each `rtdbStdlib` module's test pins its builders' output and runs allow and deny cases for set, update and delete through `rtdbRules(...).simulate` and through the sandbox's deployed rules with the client SDK; both must give each case's expected verdict. `unit:rules/rtdb/stdlib/catalog.test.ts` keeps the catalog the `rules_stdlib_list` and `rules_stdlib_get` tools return for `service: 'database'` in one-to-one agreement with the exports, with every compiled example parsing. The compiled output of the main patterns is deployed to production in the `rules-rtdb-r27-stdlib-core-patterns` capture, recorded on the RTDB rules engine rows for `.validate` scope and literal and wildcard siblings, and the presence, timing and collections patterns in `rules-rtdb-r28-stdlib-presence-timing`, recorded on the row for `now`. The auth, membership and windowed-quota patterns are deployed in `rules-rtdb-r34-stdlib-auth-membership-quota`, recorded on the same row, and replayed across simulator, sandbox, SharedWorker, and Node host. A presence case registers its offline value with onDisconnect and checks that the value lands when the connection drops.",
  oracleObservations: ["rules-rtdb-r27-stdlib-core-patterns", "rules-rtdb-r28-stdlib-presence-timing", "rules-rtdb-r34-stdlib-auth-membership-quota"],
  conformanceTests: [
    "packages/rules/test/rtdb/constraints/game.test.ts", "packages/pyric/test/rules/rtdb/stdlib/validation.test.ts", "packages/pyric/test/rules/rtdb/stdlib/lifecycle.test.ts",
    "packages/pyric/test/rules/rtdb/stdlib/lobby.test.ts", "packages/pyric/test/rules/rtdb/stdlib/turns.test.ts", "packages/pyric/test/rules/rtdb/stdlib/results.test.ts",
    "packages/pyric/test/rules/rtdb/stdlib/counters.test.ts", "packages/pyric/test/rules/rtdb/stdlib/presence.test.ts", "packages/pyric/test/rules/rtdb/stdlib/timing.test.ts",
    "packages/pyric/test/rules/rtdb/stdlib/collections.test.ts", "packages/pyric/test/rules/rtdb/stdlib/auth.test.ts", "packages/pyric/test/rules/rtdb/stdlib/membership.test.ts",
    "packages/pyric/test/rules/rtdb/stdlib/quota.test.ts", "packages/pyric/test/rules/rtdb/stdlib/catalog.test.ts", "packages/pyric/test/rules/rtdb/stdlib/corpus-lock.test.ts",
    "packages/conformance/test/rtdb-rules/capture-stdlib-and-deploy-refusals.test.ts", "packages/conformance/test/rtdb-rules/served-stdlib-and-deploy-refusals.test.ts",
  ],
});
