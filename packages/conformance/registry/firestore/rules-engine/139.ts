import { row } from './section.ts';

export default row({
  order: 160,
  behavior: "Query-proof EVALUATION — the rules-side decision (\"rules are not filters\"): given a `list` rule + query constraints, decide provable-or-reject (a doc-dependent rule like `resource.data.visibility == 'public'` is provable ONLY with a matching `where('visibility','==','public')`; otherwise the whole query is rejected) (RULES-B11 rules-side)",
  status: "conforms",
  evidence: "`unit:rules/simulator/query-proof.test.ts`",
  automation: "unit-backed",
  conformanceTests: ["packages/rules/test/simulator/query-proof.test.ts"],
});
