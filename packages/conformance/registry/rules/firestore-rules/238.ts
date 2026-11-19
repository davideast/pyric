import { row } from './section.ts';

export default row({
  order: 600,
  featureKeys: ["service"],
  behavior: "A Firestore ruleset declaring an unknown service name (`service foo.bar`) compiles with warnings rather than a compile error and denies every Firestore request (#1434)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-service-name-unknown-in-firestore` (1 case) records production compiling `service foo.bar` with `WARNING@2:9 Invalid service name: foo.bar.` (no compile error) and DENYING a Firestore `get` request. `checkRulesSource` compiles the ruleset, Firestore match resolution denies every request, and `lint()` surfaces `INVALID_SERVICE_NAME` (`Invalid service name: foo.bar.`) as a warning; replayed by `unit:rules/oracle-conformance.test.ts`, `unit:rules/grammar/source-service-check.test.ts`, and `unit:rules/grammar/corpus.test.ts`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["evaluating unknown service blocks as Firestore rules fails open, while refusing them at compile time diverges from production"],
  oracleObservations: ["rules-firestore-service-name-unknown-in-firestore"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/pyric/test/rules/grammar/source-service-check.test.ts",
    "packages/rules/test/grammar/corpus.test.ts",
    "packages/rules/test/linter/service-declarations.test.ts",
  ],
});
