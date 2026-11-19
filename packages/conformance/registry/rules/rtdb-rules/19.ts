import { row } from './section.ts';

export default row({
  order: 190,
  featureKeys: [],
  behavior: "A literal child key excludes its `$wildcard` sibling: the wildcard's `.read`, `.write` and `.validate` do not apply to a key a literal sibling names, whichever is declared first",
  evidence: "`oracle:rules-rtdb-r19-literal-and-wildcard-siblings` records production DENYING reads and writes of `special` under a denying literal next to a granting `$id`, with the literal declared first or second; ALLOWING `special` under a granting literal next to a denying `$id`; and not running `$other`'s failing `.validate` for the literal `title`. The simulator matches all 10 cases: a key a literal sibling names never goes to the wildcard, when collecting `.read`/`.write` rules or walking `.validate`. Extended 2026-10-07: `oracle:rules-rtdb-r27-stdlib-core-patterns` deploys the closed shapes the RTDB rules standard library's `validation.shape` builds, typed literal children next to a `$other` whose `.validate` is false, and records production ALLOWING a match and a player that write only the listed fields and DENYING a match and a player that add an unlisted field. The simulator and the sandbox match.",
  risk: ["rules-denial"],
  riskScore: 4,
  riskReasons: ["asserts rules allow/deny routing behavior"],
  oracleObservations: ["rules-rtdb-r19-literal-and-wildcard-siblings", "rules-rtdb-r27-stdlib-core-patterns"],
  constructs: ["rtdb.rule-kind.location-wildcard"],
});
