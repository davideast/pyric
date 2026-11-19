import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: [],
  behavior: "`int`/`float` division and type distinction (RULES-B5) in rules — truncating int÷int, float division stays float, div-by-zero denies, `is int`/`is float` distinct, `is number` true for both, and `>` ordering an int and a float by value",
  status: "conforms",
  evidence: "`oracle:rules-firestore-int-float-and-division` — production Firestore Rules Test API verdicts for all ten corpus cases, replayed verdict-for-verdict by `unit:rules/oracle-conformance.test.ts`. The simulator now revives non-integral JSON wire numbers as RulesFloat values, preserving production's float payload type while retaining bare integral numbers as ints; `unit:rules/simulator/handler.test.ts` pins both literal and payload distinctions. RECAPTURED, 2026-09-28: the scenario adds 8 production cases (18 in all). `is number` allows an int and a float payload and denies a string and a null payload. `>` between a stored and an incoming value orders an int and a float by value in both directions (10.5 > 10 and 10 > 9.5 allow, 9.5 > 10 denies), and a string beside an int is \"Unsupported operation error. Received: string > int.\", which denies. The simulator matches all 18 verdicts, and the `counters` module's `improvedBy` relies on both shapes.",
  risk: ["specific-value","rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts 1 specific value(s)","asserts rules-denial behavior"],
  oracleObservations: ["rules-firestore-int-float-and-division"],
  constructs: ["firestore.operator.div","firestore.operator.is"],
});
