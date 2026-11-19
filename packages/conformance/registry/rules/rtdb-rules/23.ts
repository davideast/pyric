import { row } from './section.ts';

export default row({
  order: 240,
  featureKeys: [],
  behavior: "Pyric's load-time check refuses the rulesets production's rules endpoint refuses for an unknown variable, `newData` in a `.read`, an unknown snapshot or value method, and an assignment, and loads the rulesets production accepts: an operand typed only at evaluation, an unknown property of `auth`, and a ruleset over the documented 256 KB limit. Rules file text reads as the deploy endpoint reads it: comments, a rule string that spans lines (LF or CRLF), a raw tab inside a rule string, and a trailing comma before `}` or `]` are accepted, and a backslash before a line break, a doubled comma and a leading comma are refused",
  evidence: "`oracle:rules-rtdb-r29-deploy-rejections` sends 33 rulesets to production's rules endpoint as dry runs (`PUT /.settings/rules.json?dryRun=true`, the validation `firebase deploy` runs before it deploys) and records each verdict and error text. Production rejects `foo == 1` (\"Unknown variable 'foo'.\"), `newData.exists()` in `.read` (\"newData is invalid in .read expressions.\"), `data.foo()` and `newData.val().bar()` (\"No such method/property\"), and `auth.uid = 'x'` (\"Rule expressions may not contain assignments.\"); Pyric's load-time check rejects the same five rulesets. Production accepts `auth.uid + 1 > 'x'`, `auth.foo == 1`, and a ruleset of about 300 KB; Pyric loads all three. `oracle:rtdb-rules-text-dialect` (captured 2026-10-07) sends 12 rules file texts byte for byte as dry runs and records production accepting comments, a rule string spanning lines with LF and with CRLF, a raw tab inside a rule string, and a trailing comma in a rule object, in every object, in an `.indexOn` array and before a comment, and refusing a backslash before a line break inside a rule string (\"Invalid escape\"), a doubled comma and a leading comma. `unit:database/oracle-conformance.test.ts` reads each text through `toStrictRulesJson`, the reader every RTDB rules load path uses, and the load-time check, and agrees with every verdict. `packages/conformance/src/rules-rtdb-replay.test.ts` replays deploy cases through the local check.",
  risk: ["rules-denial"],
  riskScore: 2,
  riskReasons: ["asserts which rulesets load and which are refused"],
  oracleObservations: ["rules-rtdb-r29-deploy-rejections", "rtdb-rules-text-dialect"],
  conformanceTests: ["packages/rules/test/rtdb/rules-conformance.test.ts", "packages/conformance/src/rules-rtdb-replay.test.ts", "packages/pyric/test/database/oracle-conformance.test.ts"],
  constructs: [
    "rtdb.binding.unknown-variable", "rtdb.binding.newData-in-read", "rtdb.method.snapshot.unknown",
    "rtdb.method.string.unknown", "rtdb.semantic.parse-error", "rtdb.operator.dynamic-operand",
    "rtdb.operator.member.auth-unknown-property", "rtdb.semantic.rules-size-limit",
  ],
});
