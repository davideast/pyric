import { row } from './section.ts';

export default row({
  order: 380,
  featureKeys: [],
  behavior: "A child named `__proto__` is an ordinary key: a write at `/__proto__` lands in the post-write tree and its `$wildcard` `.validate` runs (CS-1)",
  evidence: "`oracle:rules-rtdb-r52-prototype-named-keys` (captured 2026-10-26, 7 cases) records production DENYING a string set at `/path/__proto__` under a number-only `$k` `.validate`, as it denies one at `/path/plain` and `/ctor/constructor`. The simulator's post-write tree sets each written key as an own property (`post-write-tree.ts` `withValueAt`), so the key lands and its `.validate` runs; `unit:rules/rtdb/rules-conformance.test.ts` replays all 7 verdicts, and `unit:rules/rtdb/simulation/prototype-named-keys.test.ts` covers an update key, a listed update path, stored data and snapshot reads under `__proto__`. The object and update cases carrying an own `__proto__` key are allowed in production: the capture runner copies each case value by assignment, which drops the key, so production received an empty write. The SDK's `set()` also drops it (`ChildrenNode.val()` assigns each child), and the simulator writes such a value without the key. The SDK's `update()` sends its value as given, so the simulator keeps an own `__proto__` nested in an update value and runs its `.validate`. Fixed in #1247 stream S3.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts a write at a key named __proto__ runs its .validate as production does"],
  oracleObservations: ["rules-rtdb-r52-prototype-named-keys"],
  conformanceTests: ["packages/rules/test/rtdb/simulation/prototype-named-keys.test.ts"],
  constructs: ["rtdb.rule-kind.location-wildcard"],
});
