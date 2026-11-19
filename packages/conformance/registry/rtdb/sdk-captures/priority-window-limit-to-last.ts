import { row, CDD } from './section.ts';

export default row({
  order: 80,
  featureKeys: ['orderByPriority', 'limitToLast'],
  api: 'orderByPriority with endAt or endBefore and limitToLast over children with no priority',
  behavior: 'Production and pyric give the same keys: `z` for endAt("1","A") with limitToLast(1), `b,z` for endBefore("1") with limitToLast(2), `1,10,A,a,b,z` with no limit, and `a,b,z` for the endAt(2) limitToLast(3) control. The capture refuted hunt finding RT-17.',
  evidence: '`oracle:rtdb-modular-priority-window-limit-to-last`.',
  risk: ['specific-value'],
  riskScore: 2,
  riskReasons: ['asserts query membership'],
  oracleObservations: ['rtdb-modular-priority-window-limit-to-last'],
  conformanceTests: [`${CDD}/capture-priority-window-limit-to-last.test.ts`],
});
