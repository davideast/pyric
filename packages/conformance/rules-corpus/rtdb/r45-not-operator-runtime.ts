/**
 * ─── r45-not-operator-runtime ──────────────────────────────────────────────
 * How production evaluates `!` and `!!` on `query.orderByKey` for a plain read
 * without a query (`rules-rtdb-r45-not-operator-runtime.json`). Production
 * populates `query.orderByKey` as `false` on a plain read, so `!query.orderByKey`
 * is `ALLOW`, `!!query.orderByKey` is `DENY`, and `query.orderByKey == false`
 * is `ALLOW`.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'Decide MET-1: production populates query.orderByKey as false on a plain read, so !query.orderByKey grants and !!query.orderByKey denies.',
  provenance:
    'Captured by deploy-observe-restore against pyric-oracle-rtdb in observations/rtdb-rules/rules-rtdb-r45-not-operator-runtime.json.',
  rules: JSON.stringify({
    notkey: { '.read': '!query.orderByKey' },
    notnotkey: { '.read': '!!query.orderByKey' },
    keyfalse: { '.read': 'query.orderByKey == false' },
  }),
  cases: [
    { description: 'MET-1: !query.orderByKey on a plain read', expectation: 'ALLOW', operation: 'read', opPath: '/notkey', authPresent: false },
    { description: 'MET-1: !!query.orderByKey on a plain read', expectation: 'DENY', operation: 'read', opPath: '/notnotkey', authPresent: false },
    { description: 'MET-1 control: query.orderByKey == false on a plain read', expectation: 'ALLOW', operation: 'read', opPath: '/keyfalse', authPresent: false },
  ],
};
