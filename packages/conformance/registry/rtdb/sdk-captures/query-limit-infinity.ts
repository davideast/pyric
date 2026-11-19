import { row, CDD, SERVED } from './section.ts';

export default row({
  order: 110,
  featureKeys: ['query', 'limitToFirst', 'limitToLast', 'get', 'onValue'],
  api: 'limitToFirst(Infinity) and limitToLast(Infinity) client acceptance, unanswered reads, and rules query.* null mapping',
  behavior: 'Client `limitToFirst(Infinity)` and `limitToLast(Infinity)` construct a `Query` without throwing (while `-Infinity`, `NaN`, and `0` throw `"limitToFirst: First argument must be a positive integer."`), map non-finite limits to `null` in `query.limitToFirst` / `query.limitToLast` rules evaluation, and leave wire `get()` and `onValue()` / child listeners unanswered without stalling subsequent finite reads.',
  evidence: '`oracle:rtdb-modular-query-limit-infinity`, replayed in page and on the served worker plane.',
  risk: ['specific-value', 'listener'],
  riskScore: 2,
  riskReasons: ['asserts client limit validation, unanswered non-finite query behavior, and rules query.* null semantics'],
  oracleObservations: ['rtdb-modular-query-limit-infinity'],
  conformanceTests: [
    `${CDD}/capture-query-limit-infinity.test.ts`,
    `${SERVED}/rtdb-query-limit-infinity.test.ts`,
  ],
});
