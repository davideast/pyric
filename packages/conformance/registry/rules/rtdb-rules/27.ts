import { row } from './section.ts';

export default row({
  order: 280,
  featureKeys: [],
  behavior: "Pyric's load-time check refuses a `database.rules.json` that production's rules endpoint refuses to deploy for its tree structure or for a type error in a rule, with the endpoint's text. Tree structure: two `$` children of one node, a number or object as a rule value, a number as `.indexOn`, a key containing `#`, a `.`-prefixed key that is not a rule, and a child whose value is a string. Type errors: an undeclared `$` variable, an unknown `query` field, `child()` with no argument or two, `length()` called as a method, a property read on a snapshot, a snapshot used as an operand, `'a' - 1`, `true > 1` and `!'a'`, a rule whose result is a string or a number, a snapshot method on `auth` or a string method on a snapshot, and `matches()` with a string or `hasChild()` with a number. A rejected ruleset leaves the rules in force. The forms inferred from those texts but not yet captured (an `.indexOn` array with a non-string member, a key holding `.`, `/`, `[`, `]` or an inner `$` without `#`) load with a warning",
  evidence: "`oracle:rules-rtdb-r29-deploy-rejections` sends each of these rulesets to production's rules endpoint as a dry run and records the verdict and text: two `$` children (\"Cannot have multiple default rules ('$x' and '$y').\"), a number or an object as a rule value (\"Invalid rule expression.  Expected 'true', 'false', or an expression string.\"), a number as `.indexOn` (\"Invalid indexOn expression. Must be either a string or an array of strings\"), a child key containing `#` (\"String can't contain `.`, `#`, `$`, `/`, `[`, or `]`\"), and a `.`-prefixed key that is not a rule or a child that is a string (\"Expected '{'.\"). `unit:rtdb/source-rejection.test.ts` loads each of them through `rtdbRulesSourceRejection`, which every RTDB rules load path calls, and asserts the same text; `unit:rtdb/rules-conformance.test.ts` and the replay in `rules-rtdb-replay.test.ts` agree with every recorded verdict, the type errors included.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts which rulesets load and which are refused"],
  oracleObservations: ["rules-rtdb-r29-deploy-rejections"],
  conformanceTests: ["packages/rules/test/rtdb/source-rejection.test.ts", "packages/rules/test/rtdb/rules-conformance.test.ts", "packages/conformance/src/rules-rtdb-replay.test.ts"],
  constructs: [
    "rtdb.rule-kind.sibling-wildcards", "rtdb.rule-kind.unknown-key", "rtdb.rule-kind.non-expression-value",
    "rtdb.rule-kind.indexOn-non-string", "rtdb.rule-kind.invalid-key", "rtdb.rule-kind.non-object-child",
    "rtdb.rule-kind.non-boolean-result", "rtdb.binding.unbound-path-variable", "rtdb.binding.query.unknown-field",
    "rtdb.method.snapshot.arity", "rtdb.method.string.length-call", "rtdb.operator.member.snapshot-property",
    "rtdb.operator.snapshot-operand", "rtdb.operator.type-mismatch", "rtdb.semantic.method-wrong-receiver",
    "rtdb.semantic.method-argument-type",
  ],
});
