import { row } from './section.ts';

export default row({
  order: 250,
  featureKeys: [],
  behavior: "A `.read` rule reads the request's query through `query`: `orderByChild`, `orderByValue`, `equalTo`, `startAt`, `endAt`, `limitToFirst` and `limitToLast` carry the query's values, `orderByChild` reads null for a read without a query, and a limit the query does not set reads null, so a bound on it fails the rule",
  evidence: "`oracle:rules-rtdb-r30-query-rules` runs 20 reads against production, 15 of them queries built with the Web SDK. Production allows an `orderByChild('owner').equalTo(uid)` list read for the user's own uid, and denies another uid, another child, a plain read, and a signed-out query; reads `orderByValue` as true under `orderByValue()`; reads `startAt` and `endAt` as the range bounds and denies a different `startAt`; reads `orderByChild` as null for a plain read and not null under `orderByChild`; grants `limitToFirst <= 2` and `limitToLast <= 2` under a limit of 2 and denies a limit of 3; and denies `limitToFirst <= 2` for a plain read and `limitToLast <= 2` under `limitToFirst(1)`, where the unset limit is null and `<=` with a null operand fails the rule (row #22). The simulator matches each of these cases; see row #26 for `orderByKey` and `orderByPriority`.",
  risk: ["rules-denial"],
  riskScore: 3,
  riskReasons: ["asserts query-gated read allow/deny behavior"],
  oracleObservations: ["rules-rtdb-r30-query-rules"],
  constructs: [
    "rtdb.binding.query", "rtdb.binding.query.orderByChild", "rtdb.binding.query.orderByValue",
    "rtdb.binding.query.equalTo", "rtdb.binding.query.startAt", "rtdb.binding.query.endAt",
    "rtdb.binding.query.limitToFirst", "rtdb.binding.query.limitToLast",
  ],
});
