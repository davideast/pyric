import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["mapMembership","constructorAccess"],
  behavior: "Own-keys-only map membership and constructor-access denial (RULES-B7) in rules — `'toString' in map` is `false`, `.constructor` access errors (no JS prototype-chain leakage)",
  status: "conforms",
  evidence: "`oracle:rules-firestore-prototype-chain-keys` — production Firestore Rules Test API verdicts for corpus scenario \"prototype-chain-keys\", replayed verdict-for-verdict against the local rules simulator by `unit:rules/oracle-conformance.test.ts`; all cases match production. RECAPTURED, 2026-09-27: the scenario adds 6 production cases (11 in all) for `in` over a value that is not a collection. Each is an evaluation error that denies, so its negation denies too: `!('a' in null)` is \"Null value error.\", `!('a' in 'abc')`, `!('a' in 5)`, `!('a' in 1.5)` and `!('a' in true)` are \"Function not found error: Name: [in].\", and `!(1 in {'a': 1})` is \"Unsupported operation error. Received: map.in(int). Expected: map.in(string).\". The simulator returned false for each, so each negation allowed; it now raises production's error text and matches production on all 11 cases. `unit:rules/simulator/in-operand-errors.test.ts` pins the verdicts and the text. RECAPTURED, 2026-09-28: the scenario adds 5 production cases (16 in all). `'a' in` a set built by `toSet()` allows and `!('items' in` that set) allows: set membership tests elements. `in` over `request.time`, `request.path` or a map diff is \"Function not found error: Name: [in].\", so each negation denies. The simulator returned false for a timestamp, path or map diff, so those negations allowed. The simulator and the Storage evaluator now share one `in` implementation (`rules/simulator/membership.ts`), which matches production on all 16 cases; `unit:rules/membership.test.ts` runs every shape through both engines.",
  oracleObservations: ["rules-firestore-prototype-chain-keys"],
  conformanceTests: [
    "packages/pyric/test/rules/oracle-conformance.test.ts",
    "packages/rules/test/simulator/in-operand-errors.test.ts",
    "packages/rules/test/membership.test.ts",
  ],
});
