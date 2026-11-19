import { row } from './section.ts';

export default row({
  order: 140,
  behavior: "Int/float distinction (`1.5 is int`→false, `1 is float`→false, `1.0 is float`→true) + integer division (`10 / 4 == 2`) + int div/mod-by-zero ERRORS (RULES-B5); strict `int('12abc')`/`float('abc')` parsing (RULES-B6 rest); `bool()` is not a Firestore rules function, so `bool('true')` is \"Function not found error: Name: [bool]\" and denies; `string(1.0)`→\"1.0\" (RULES-B12 rest)",
  status: "conforms",
  evidence: "`unit:rules/simulator/evaluator.test.ts` (RULES-B5 + \"RULES-B6 remainder\" blocks); `unit:rules/simulator/handler.test.ts` (\"RULES-B5 end-to-end\" block). Production's missing `bool()` is recorded by Firestore Rules row `firestore-rules#191`, whose capture `rules-firestore-ast-strictness-and-unsupported-casts` shows the error.",
  automation: "unit-backed",
  conformanceTests: ["packages/rules/test/simulator/evaluator.test.ts","packages/rules/test/simulator/handler.test.ts"],
});
