import { row } from './section.ts';

export default row({
  order: 190,
  featureKeys: [],
  behavior: "Ternary `?:` — branch selection, error-in-condition deny, and `error || true` absorption",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-17: production capture proves the evaluator selects ternary branches by condition, denies when the CONDITION errors (even with identical `true` branches — production errors the whole conditional rather than falling through to a branch), and still absorbs the same error through `|| true`. `oracle:rules-storage-ternary-and-error-absorption` matches production verdict-for-verdict on all 5 cases. A division-by-zero in the condition previously yielded JS Infinity (no error) and false-ALLOWed the erroring-condition case; zero divisors now error-and-deny.",
  risk: ["rules-denial"],
  riskScore: 1,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-ternary-and-error-absorption"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts"],
  constructs: ["storage.operator.ternary","storage.operator.or","storage.operator.div"],
});
