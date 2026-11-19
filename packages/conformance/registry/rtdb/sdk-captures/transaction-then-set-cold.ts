import { row, CDD, SERVED } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['runTransaction', 'set'],
  api: 'runTransaction(ref, fn) followed at once by set(ref, value)',
  behavior: "On a cold client across in-page and served planes, a seeded-path speculative-null transaction overtaken by set(ref, value) rejects with codeless Error('set') while the set lands; a warm client commits before the set. RT-15.",
  evidence: "`oracle:rtdb-modular-transaction-then-set` keys `cold` and `warm` (both clients were cold) and `oracle:rtdb-modular-transaction-then-set-warm`, replayed in page and on the served SharedWorker and Node host planes.",
  risk: ['atomicity', 'error-code'],
  riskScore: 3,
  riskReasons: ['asserts transaction/batch atomicity', "asserts the Error('set') rejection"],
  oracleObservations: ['rtdb-modular-transaction-then-set', 'rtdb-modular-transaction-then-set-warm'],
  conformanceTests: [`${CDD}/capture-transaction-then-set.test.ts`, `${SERVED}/rtdb-transaction-then-set.test.ts`],
});
