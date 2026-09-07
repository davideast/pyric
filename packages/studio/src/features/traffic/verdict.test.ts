/** Traffic verdict derivation (specs/traffic.md MVP) — pure mapping tests. */
import { describe, expect, it } from 'bun:test';
import type { OperationContext } from 'pyric/sandbox';
import {
  rulesDecisionEvents,
  queryProofUnsupportedCount,
  actingIdentity,
  denialReasons,
  filterByVerdict,
  filterStudioTraffic,
  isStudioTraffic,
  opensRulesInspector,
  subjectTarget,
  verdictFor,
  verdictLabel,
} from './verdict.js';

describe('verdictFor', () => {
  it('maps rule-evaluated results', () => {
    expect(verdictFor({ rulesDisposition: { kind: 'evaluated', verdict: 'allow' } })).toBe('allow');
    expect(verdictFor({ rulesDisposition: { kind: 'evaluated', verdict: 'deny' } })).toBe('deny');
  });

  it('labels a rules bypass without conflating it with the admin lens', () => {
    expect(verdictFor({ rulesDisposition: { kind: 'bypassed', reason: 'admin' } })).toBe(
      'bypassed',
    );
  });

  it('is blank for non-rule ops', () => {
    expect(verdictFor({ rulesDisposition: { kind: 'not-evaluated', reason: 'no-rules' } })).toBeNull();
    expect(verdictFor({ rulesDisposition: { kind: 'not-evaluated', reason: 'unsupported' } })).toBeNull();
  });

  it('does not derive a rules verdict from the auth lens', () => {
    expect(verdictFor({ rulesDisposition: { kind: 'evaluated', verdict: 'deny' } })).toBe('deny');
  });
});

describe('filterByVerdict', () => {
  const events = [
    { id: 'a', rulesDisposition: { kind: 'evaluated', verdict: 'allow' } },
    { id: 'b', rulesDisposition: { kind: 'evaluated', verdict: 'deny' } },
    { id: 'c', rulesDisposition: { kind: 'bypassed', reason: 'admin' } },
    { id: 'd', rulesDisposition: { kind: 'not-evaluated', reason: 'no-rules' } },
  ] as const;

  it('passes everything through on all (including blank-verdict ops)', () => {
    expect(filterByVerdict(events, 'all').map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('filters to one verdict', () => {
    expect(filterByVerdict(events, 'allow').map((e) => e.id)).toEqual(['a']);
    expect(filterByVerdict(events, 'deny').map((e) => e.id)).toEqual(['b']);
    expect(filterByVerdict(events, 'bypassed').map((e) => e.id)).toEqual(['c']);
  });
});

describe('actingIdentity', () => {
  it('prefers the pinned lens', () => {
    expect(actingIdentity({ auth: { uid: 'tab-user' }, operationContext: { source: { kind: 'studio' }, authLens: { mode: 'admin' } } })).toBe(
      'admin (rules bypassed)',
    );
    expect(
      actingIdentity({ auth: null, operationContext: { source: { kind: 'studio' }, authLens: { mode: 'as', uid: 'alice' } } }),
    ).toBe('as alice');
    expect(actingIdentity({ auth: { uid: 'tab-user' }, operationContext: { source: { kind: 'studio' }, authLens: { mode: 'anon' } } })).toBe(
      'anonymous',
    );
  });

  it('falls back to the op auth state for an app-session lens', () => {
    expect(
      actingIdentity({ auth: { uid: 'bob' }, operationContext: { source: { kind: 'app' }, authLens: { mode: 'app-session' } } }),
    ).toBe('bob');
  });
});

describe('subjectTarget', () => {
  it('routes a Firestore op (default service) to its path', () => {
    expect(subjectTarget({ method: 'get', path: 'users/alice' })).toEqual({
      tab: 'firestore',
      rest: ['users', 'alice'],
    });
    expect(subjectTarget({ service: 'firestore', method: 'list', path: 'notes' })).toEqual({
      tab: 'firestore',
      rest: ['notes'],
    });
  });

  it('routes an RTDB op to the viewer tab (path is component state — N4 gap)', () => {
    expect(subjectTarget({ service: 'rtdb', method: 'get', path: '/rooms/r1' })).toEqual({ tab: 'rtdb' });
  });

  it('routes storage to the object path and auth to the uid', () => {
    expect(subjectTarget({ service: 'storage', method: 'get', path: 'uploads/logo.png' })).toEqual({
      tab: 'storage',
      rest: ['uploads', 'logo.png'],
    });
    expect(subjectTarget({ service: 'auth', method: 'get', path: 'u-1' })).toEqual({
      tab: 'auth',
      rest: ['u-1'],
    });
  });

  it('routes a Storage list to its prefix without conflating it with an object', () => {
    expect(subjectTarget({ service: 'storage', method: 'list', path: 'avatars' })).toEqual({
      tab: 'storage',
      rest: ['avatars'],
      query: { kind: 'prefix' },
    });
    expect(subjectTarget({ service: 'storage', method: 'get', path: 'avatars' })).toEqual({
      tab: 'storage',
      rest: ['avatars'],
    });
  });

  it('routes a Storage root list to the bucket root', () => {
    expect(subjectTarget({ service: 'storage', method: 'list', path: '' })).toEqual({
      tab: 'storage',
    });
    expect(subjectTarget({ service: 'storage', method: 'list', path: '/' })).toEqual({
      tab: 'storage',
    });
  });

  it('yields nothing for non-addressable subjects', () => {
    expect(subjectTarget({ service: 'auth', method: 'delete', path: '*' })).toBeNull();
    expect(subjectTarget({ service: 'rtdb', method: 'get', path: '(service)' })).toBeNull();
    expect(subjectTarget({ method: 'get', path: '' })).toBeNull();
    expect(subjectTarget({ service: 'firestore', method: 'list', path: '/' })).toBeNull();
  });
});

describe('opensRulesInspector (row-click semantics)', () => {
  it('rules-evaluated rows open the inspector: allow AND deny', () => {
    expect(opensRulesInspector({ rulesDisposition: { kind: 'evaluated', verdict: 'allow' } })).toBe(true);
    expect(opensRulesInspector({ rulesDisposition: { kind: 'evaluated', verdict: 'deny' } })).toBe(true);
  });

  it('admin-bypass rows keep subject navigation (rules never ran)', () => {
    expect(opensRulesInspector({ rulesDisposition: { kind: 'bypassed', reason: 'admin' } })).toBe(false);
  });

  it('blank-verdict rows keep subject navigation (no rules decision)', () => {
    expect(opensRulesInspector({ rulesDisposition: { kind: 'not-evaluated', reason: 'no-rules' } })).toBe(false);
  });
});

describe('denialReasons', () => {
  it('returns the non-empty reasoning lines', () => {
    expect(denialReasons({ reasons: ['Rule #2 (update) → DENY', '', '  '] })).toEqual([
      'Rule #2 (update) → DENY',
    ]);
    expect(denialReasons({})).toEqual([]);
  });
});

describe('filterStudioTraffic', () => {
  type Ev = { id: string; operationContext: OperationContext };
  const studio: Ev = { id: 's1', operationContext: { source: { kind: 'studio' }, authLens: { mode: 'admin' } } };
  const studioAsUser: Ev = { id: 's2', operationContext: { source: { kind: 'studio' }, authLens: { mode: 'as', uid: 'alice' } } };
  const app: Ev = { id: 'a1', operationContext: { source: { kind: 'app' }, authLens: { mode: 'app-session' } } };
  const appAdmin: Ev = { id: 'a2', operationContext: { source: { kind: 'app' }, authLens: { mode: 'admin' } } };
  const agent: Ev = { id: 'g1', operationContext: { source: { kind: 'agent', name: 'claude' }, authLens: { mode: 'admin' } } };

  it('drops only studio-issued events when hiding', () => {
    expect(filterStudioTraffic([studio, studioAsUser, app, appAdmin, agent], true)).toEqual([
      app,
      appAdmin,
      agent,
    ]);
  });

  it('is a pass-through copy when not hiding', () => {
    const input = [studio, app];
    const out = filterStudioTraffic(input, false);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('classifies via source only, not the auth lens', () => {
    expect(isStudioTraffic(studioAsUser)).toBe(true);
    expect(isStudioTraffic(appAdmin)).toBe(false);
  });
});

 it('keeps proof limitations distinct through filters and allows inspection', () => {
   const event = {result: 'deny', rulesDisposition: {kind: 'evaluated', verdict: 'deny'} as const,
     queryProof: {kind: 'unsupported-predicate', failures: []} as const};
   const input = {...event, queryProof: {kind: event.queryProof.kind, failures: []}};
   expect(verdictFor(input)).toBe('proof-unsupported');
   expect(verdictLabel('proof-unsupported')).toBe('Query proof unsupported');
   expect(filterByVerdict([input], 'deny')).toHaveLength(0);
   expect(filterByVerdict([input], 'proof-unsupported')).toHaveLength(1);
   expect(opensRulesInspector(input)).toBe(true);
   expect(verdictFor({...input, result: 'allow', rulesDisposition: {kind: 'evaluated', verdict: 'allow'}})).toBe('allow');
   for (const kind of ['constraints-not-satisfied', 'residual-denied', 'no-rule'] as const) {
     expect(verdictFor({...input, queryProof: {kind, failures: []}})).toBe('deny');
   }
 });

it('counts proof limitations separately within the metrics time window', () => {
  const proof = {at: 10, result: 'deny', rulesDisposition: {kind: 'evaluated', verdict: 'deny'} as const,
    queryProof: {kind: 'unsupported-path' as const, failures: []}};
  const denied = {at: 10, result: 'deny', rulesDisposition: {kind: 'evaluated', verdict: 'deny'} as const};
  const events = [proof, denied, {...proof, at: 20}];
  expect(rulesDecisionEvents(events)).toEqual([denied]);
  expect(queryProofUnsupportedCount(events, {start: 10, end: 20})).toBe(1);
});
