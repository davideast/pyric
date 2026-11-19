import { row } from './section.ts';

export default row({
  order: 80,
  behavior: "`matches()` is a **full-string** anchored RE2 test; `replace()`/`split()` take regexes (`replace` = all occurrences) (RULES-B4)",
  status: "conforms",
  evidence: "`unit:rules/simulator/evaluator.test.ts` (RULES-B4 block)",
  automation: "unit-backed",
  conformanceTests: ["packages/rules/test/simulator/evaluator.test.ts"],
});
