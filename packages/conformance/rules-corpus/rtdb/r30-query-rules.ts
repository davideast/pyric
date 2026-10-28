/**
 * ─── r30-query-rules ──────────────────────────────────────────────────────
 * `.read` rules that test the `query` variable, evaluated against real query
 * reads. Each node gates on one query field:
 *
 *   - `orderByChild` with `equalTo` (the documented owner-scoped list read),
 *   - `limitToFirst` and `limitToLast` bounds,
 *   - `orderByKey`, `orderByValue` and `orderByPriority`,
 *   - `startAt` and `endAt`,
 *   - and what each field reads for a plain read that applies no query.
 */
import type { RtdbScenarioRecord } from './types.ts';

export const scenario: RtdbScenarioRecord = {
  fm: 'rtdb#71',
  rationale:
    'a query-gated .read decides list access in production, so the simulator must read the same query fields with the same values, and the same nulls and booleans for a read without a query.',
  provenance:
    'Authored to pin the rules `query` variable against real query reads. Expectations are the production allow/deny verdicts recorded by the deploy-observe-restore capture in observations/rtdb-rules/rules-rtdb-r30-query-rules.json.',
  rules: JSON.stringify({
    items: {
      '.read': "query.orderByChild == 'owner' && query.equalTo == auth.uid",
      '.indexOn': ['owner'],
    },
    firstpage: { '.read': 'query.limitToFirst <= 2' },
    lastpage: { '.read': 'query.limitToLast <= 2' },
    bykey: { '.read': 'query.orderByKey == true' },
    byvalue: { '.read': 'query.orderByValue == true', '.indexOn': '.value' },
    bypriority: { '.read': 'query.orderByPriority == true' },
    range: { '.read': "query.startAt == 'b' && query.endAt == 'm'" },
    noorder: { '.read': 'query.orderByChild == null' },
    nolimit: { '.read': 'query.limitToFirst == null' },
    keyfalse: { '.read': 'query.orderByKey == false' },
  }),
  cases: [
    { description: 'orderByChild owner equalTo own uid is allowed', expectation: 'ALLOW', operation: 'query', opPath: '/items', authPresent: true, query: { orderByChild: 'owner', equalTo: '<UID>' } },
    { description: 'orderByChild owner equalTo another uid is denied', expectation: 'DENY', operation: 'query', opPath: '/items', authPresent: true, query: { orderByChild: 'owner', equalTo: 'someone-else' } },
    { description: 'orderByChild on another child is denied', expectation: 'DENY', operation: 'query', opPath: '/items', authPresent: true, query: { orderByChild: 'name', equalTo: '<UID>' } },
    { description: 'a plain read of the owner-gated list is denied', expectation: 'DENY', operation: 'read', opPath: '/items', authPresent: true },
    { description: 'limitToFirst within the bound is allowed', expectation: 'ALLOW', operation: 'query', opPath: '/firstpage', authPresent: true, query: { limitToFirst: 2 } },
    { description: 'limitToFirst over the bound is denied', expectation: 'DENY', operation: 'query', opPath: '/firstpage', authPresent: true, query: { limitToFirst: 3 } },
    { description: 'a plain read of the limitToFirst-gated node is denied', expectation: 'DENY', operation: 'read', opPath: '/firstpage', authPresent: true },
    { description: 'limitToLast within the bound is allowed', expectation: 'ALLOW', operation: 'query', opPath: '/lastpage', authPresent: true, query: { limitToLast: 2 } },
    { description: 'limitToFirst does not satisfy a limitToLast bound', expectation: 'DENY', operation: 'query', opPath: '/lastpage', authPresent: true, query: { limitToFirst: 1 } },
    { description: 'orderByKey reads true under orderByKey', expectation: 'ALLOW', operation: 'query', opPath: '/bykey', authPresent: true, query: { orderByKey: true } },
    { description: 'orderByKey is not true for a plain read', expectation: 'DENY', operation: 'read', opPath: '/bykey', authPresent: true },
    { description: 'orderByValue reads true under orderByValue', expectation: 'ALLOW', operation: 'query', opPath: '/byvalue', authPresent: true, query: { orderByValue: true } },
    { description: 'orderByPriority reads true under orderByPriority', expectation: 'ALLOW', operation: 'query', opPath: '/bypriority', authPresent: true, query: { orderByPriority: true } },
    { description: 'startAt and endAt read the range bounds', expectation: 'ALLOW', operation: 'query', opPath: '/range', authPresent: true, query: { orderByKey: true, startAt: 'b', endAt: 'm' } },
    { description: 'a different startAt is denied', expectation: 'DENY', operation: 'query', opPath: '/range', authPresent: true, query: { orderByKey: true, startAt: 'a', endAt: 'm' } },
    { description: 'orderByChild reads null for a plain read', expectation: 'ALLOW', operation: 'read', opPath: '/noorder', authPresent: true },
    { description: 'orderByChild is not null under orderByChild', expectation: 'DENY', operation: 'query', opPath: '/noorder', authPresent: true, query: { orderByChild: 'owner' } },
    { description: 'limitToFirst reads null for a plain read', expectation: 'ALLOW', operation: 'read', opPath: '/nolimit', authPresent: true },
    { description: 'orderByKey reads false for a plain read', expectation: 'ALLOW', operation: 'read', opPath: '/keyfalse', authPresent: true },
    { description: 'signed out, the owner-gated query is denied', expectation: 'DENY', operation: 'query', opPath: '/items', authPresent: false, query: { orderByChild: 'owner', equalTo: 'someone-else' } },
  ],
};
