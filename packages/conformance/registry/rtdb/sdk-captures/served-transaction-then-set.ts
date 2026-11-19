import { row, CDD, SERVED } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['runTransaction', 'set'],
  api: 'runTransaction then set on the served planes',
  behavior: "On the served SharedWorker and Node host planes, a warm client write queued behind an in-flight transaction waits for the transaction to settle and commits on top (keeping the set's 100 rather than rerunning the transaction to 101), while a cold client's speculative-null transaction overtaken by set rejects with Error('set'). RP-4, RT-15.",
  evidence: '`oracle:rtdb-modular-transaction-then-set` and `oracle:rtdb-modular-transaction-then-set-warm`, replayed on the served SharedWorker and Node host planes and in page.',
  risk: ['atomicity'],
  riskScore: 3,
  riskReasons: ['asserts transaction/batch atomicity'],
  oracleObservations: ['rtdb-modular-transaction-then-set', 'rtdb-modular-transaction-then-set-warm'],
  conformanceTests: [`${SERVED}/rtdb-transaction-then-set.test.ts`, `${CDD}/capture-transaction-then-set.test.ts`],
});
