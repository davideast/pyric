import { row } from './section.ts';

export default row({
  order: 200,
  featureKeys: [],
  behavior: "`in` on list literals (membership) and on maps (OWN-key membership) — prototype names (`toString`/`constructor`/`hasOwnProperty`) are never keys",
  status: "conforms",
  evidence: "NEW ROW, 2026-07-17: production capture proves `in` tests list membership and map OWN keys only — `'toString' in metadata` is false unless the map literally carries that key, for both custom-metadata maps and map literals. `oracle:rules-storage-in-membership-and-proto-keys` matches production verdict-for-verdict on all 8 cases. Pre-fix the evaluator used JS `in`, which walks the prototype chain and false-ALLOWed the proto-key cases (the same bug class the Firestore simulator fixed under RULES-B7); the own-key check now guards it, pinned by `unit:storage/sandbox/rules-values.test.ts` JS-semantics guards. RECAPTURED, 2026-09-28: the scenario adds 9 production cases (17 in all) for `in` over a value that is not a collection. Each is an evaluation error that denies, so its negation denies too: `!('a' in null)` is \"Null value error.\"; `in` over a string, an int, a float, a bool, `request.time`, `request.path` or a map diff is \"Function not found error: Name: [in].\"; and `!(1 in metadata)` is \"Unsupported operation error. Received: map.in(int). Expected: map.in(string).\". Storage reports the same verdict and text as Firestore for each. The evaluator returned false for an int key into a map, so its negation allowed, and reported its own text for the other shapes; it now shares the Firestore simulator's `in` implementation (`rules/simulator/membership.ts`) and matches production on all 17 cases. `unit:rules/membership.test.ts` runs every shape through both engines and pins the text.",
  risk: ["rules-denial"],
  riskScore: 1,
  riskReasons: ["asserts rules-denial behavior"],
  automation: "oracle-backed",
  oracleObservations: ["rules-storage-in-membership-and-proto-keys"],
  conformanceTests: ["packages/rules/test/storage/rules-oracle-conformance.test.ts", "packages/rules/test/membership.test.ts"],
  constructs: ["storage.operator.in"],
});
