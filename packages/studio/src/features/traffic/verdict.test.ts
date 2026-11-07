/** Traffic verdict derivation (specs/traffic.md MVP) — pure mapping tests. */
import { describe, expect, it } from 'bun:test';
import type { OperationContext } from 'pyric/sandbox';
import type { StudioTrafficEvent } from './verdict.js';
import {
  rulesDecisionEvents,
  queryProofUnsupportedCount,
  actingIdentity,
  denialReasons,
  filterByVerdict,
  filterStudioTraffic,
  isStudioTraffic,
  declaredOperations,
  liveRuleEvaluation,
  liveUnevaluatedInspection,
  localDrift,
  opensLiveRulesInspector,
  opensRulesInspector,
  productionLabel,
  rowNavigationTarget,
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

describe('productionLabel', () => {
  it("reads production's answer, not a Rules verdict", () => {
    expect(productionLabel({ outcome: { status: 'ok' } })).toBe('production ok');
    expect(productionLabel({ outcome: { status: 'error', code: 'permission-denied' } })).toBe('production denied');
    expect(productionLabel({ outcome: { status: 'error', code: 'unavailable' } })).toBe('production failed: unavailable');
  });

  it('leaves an observed op without a Rules verdict', () => {
    expect(verdictFor({ rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' } })).toBeNull();
  });
});

describe('localDrift', () => {
  const denied = { status: 'error', code: 'permission-denied' } as const;
  const rule = { line: 7, expression: 'request.auth != null', path: '/rooms/{room}' };

  it('returns the local verdict when it disagrees with production', () => {
    const local = { result: 'allow', rule, drift: true } as const;
    expect(localDrift({ production: { outcome: denied, local } })).toEqual(local);
  });

  it('leaves an agreeing verdict, a gap and a sandbox op without one', () => {
    expect(localDrift({ production: { outcome: denied, local: { result: 'deny', rule } } })).toBeUndefined();
    expect(localDrift({ production: { outcome: denied, local: { result: 'unevaluated', needs: ['stored-document'] } } })).toBeUndefined();
    expect(localDrift({ production: { outcome: denied } })).toBeUndefined();
    expect(localDrift({})).toBeUndefined();
  });
});

describe('liveRuleEvaluation', () => {
  const trace = {
    version: 'local-rules', scope: 'request', decision: 'ALLOW', truncated: false,
    rules: [{ expression: 'request.auth != null', verdict: 'ALLOW', line: 5, path: '/rooms/{room}', checks: [
      { expression: 'request.auth', parent: 0, kind: 'memberAccess', state: 'unavailable' },
      { expression: 'request.auth != null', parent: null, operator: '!=', kind: 'binaryOp', state: 'value', value: true },
    ] }],
    paths: [{ path: '/rooms/{room}', matched: true, line: 4 }],
  } as const;
  const live = (local: unknown) => ({
    id: 'live-1', kind: 'operation', service: 'firestore', at: 1000, method: 'getDoc', path: 'rooms/vip',
    auth: { uid: 'alice' }, result: 'deny', reasons: [], origin: 'user',
    operationContext: { source: { kind: 'app' }, authLens: { mode: 'app-session' } },
    rulesDisposition: { kind: 'not-evaluated', reason: 'production-served' },
    production: { outcome: { status: 'error', code: 'permission-denied' }, local },
  }) as unknown as StudioTrafficEvent;

  it("projects the local trace into the sandbox view's shape, with the local verdict", () => {
    const evaluation = liveRuleEvaluation(live({ result: 'allow', drift: true, trace }));
    expect(evaluation).toMatchObject({
      id: 'live-1', result: 'allow', service: 'firestore', method: 'get', path: 'rooms/vip', auth: { uid: 'alice' },
      matchedRule: { ruleIndex: 0, operations: ['get'] },
      evaluatedRule: { verdict: 'allow', line: 5, expression: 'request.auth != null' },
    });
    expect(evaluation?.evaluatedRule?.expressionTrace).toEqual([
      { source: 'request.auth', kind: 'memberAccess', parent: 0 },
      { source: 'request.auth != null', kind: 'binaryOp', parent: null, operator: '!=', value: true },
    ]);
  });

  it("names the rule by the operations its line declares in the loaded rules source", () => {
    const source = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{db}/documents {\n    match /rooms/{room} {\n      allow read: if request.auth != null;\n    }\n  }\n}\n";
    const evaluation = liveRuleEvaluation(live({ result: 'allow', drift: true, trace }), source);
    expect(evaluation?.matchedRule).toEqual({ ruleIndex: 0, operations: ['read'] });
    expect(evaluation?.method).toBe('get');
  });

  it('leaves an op with no trace to its current details', () => {
    expect(liveRuleEvaluation(live({ result: 'allow', drift: true }))).toBeUndefined();
    expect(liveRuleEvaluation(live({ result: 'unevaluated', needs: ['stored-document'] }))).toBeUndefined();
    expect(liveRuleEvaluation(live(undefined))).toBeUndefined();
  });
});

describe('declaredOperations', () => {
  const source = "service cloud.firestore {\n  match /rooms/{room} {\n    allow read, write: if true;\n    allow get;\n  }\n}\n// @pyric-source-map: []";
  it("reads the allow statement's operations on a line", () => {
    expect(declaredOperations(source, 3)).toEqual(['read', 'write']);
    expect(declaredOperations(source, 4)).toEqual(['get']);
  });

  it('gives none without a source, a line or an allow statement', () => {
    expect(declaredOperations(undefined, 3)).toBeUndefined();
    expect(declaredOperations(source, undefined)).toBeUndefined();
    expect(declaredOperations(source, 2)).toBeUndefined();
    expect(declaredOperations(source, 99)).toBeUndefined();
  });
});

describe('live RTDB rules evaluation, unevaluated inspection, and Live mode navigation', () => {
  const RTDB_RULES_JSON = [
    '{',
    '  "rules": {',
    '    ".read": "false",',
    '    "rooms": {',
    '      "$roomId": {',
    '        ".read": "auth != null",',
    '        ".write": "auth.uid === $roomId && newData.exists()"',
    '      }',
    '    }',
    '  }',
    '}',
  ].join('\n');

  const rtdbLive = (
    method: string,
    path: string,
    local: unknown,
    outcome: { status: 'ok' } | { status: 'error'; code: string } = { status: 'ok' },
  ): StudioTrafficEvent =>
    ({
      id: `rtdb-${method}`,
      kind: 'operation',
      service: 'rtdb',
      at: 2_000,
      method,
      path,
      auth: { uid: 'alice' },
      result: outcome.status === 'ok' ? 'allow' : 'deny',
      reasons: [],
      origin: 'user',
      operationContext: { source: { kind: 'app' }, authLens: { mode: 'app-session' } },
      rulesDisposition: { kind: 'not-evaluated', reason: 'external-execution' },
      production: { outcome, local },
    }) as unknown as StudioTrafficEvent;

  it('projects a decided live RTDB allow, listener read, and implicit deny into Denial.rules', () => {
    const allowEval = liveRuleEvaluation(
      rtdbLive('onValue', '/rooms/s1', {
        result: 'allow',
        rtdb: {
          matchedPath: '/rooms/$roomId',
          matchedRule: 'auth != null',
          pathVariableBindings: { $roomId: 's1' },
          reason: 'Rule expression evaluated to true',
          rtdbTrace: [
            { path: '/', kind: 'read', conditionText: 'false', verdict: 'DENY', pathVariableBindings: {} },
            {
              path: '/rooms/$roomId',
              kind: 'read',
              conditionText: 'auth != null',
              verdict: 'ALLOW',
              pathVariableBindings: { $roomId: 's1' },
            },
          ],
        },
      }),
      RTDB_RULES_JSON,
    );
    expect(allowEval).toMatchObject({
      id: 'rtdb-onValue',
      result: 'allow',
      service: 'rtdb',
      method: 'listen',
      path: '/rooms/s1',
      rules: {
        engine: 'rtdb',
        matchedPath: '/rooms/$roomId',
        matchedRule: 'auth != null',
        pathVariableBindings: { $roomId: 's1' },
      },
    });
    expect(allowEval?.rules?.rtdbTrace).toHaveLength(2);

    const implicitDeny = liveRuleEvaluation(
      rtdbLive(
        'get',
        '/private/node',
        {
          result: 'deny',
          rtdb: {
            matchedPath: '',
            matchedRule: '',
            errorCode: 'NO_MATCHING_RULE',
            rtdbTrace: [],
          },
        },
        { status: 'error', code: 'permission_denied' },
      ),
      RTDB_RULES_JSON,
    );
    expect(implicitDeny).toMatchObject({
      result: 'deny',
      service: 'rtdb',
      method: 'get',
      rules: { engine: 'rtdb', errorCode: 'NO_MATCHING_RULE' },
    });
  });

  it('projects unevaluated RTDB and Firestore live rows with applicable rule line and honest gap details', () => {
    const rtdbWrite = rtdbLive('set', '/rooms/alice', {
      result: 'unevaluated',
      needs: ['write-data'],
      rule: { path: '/rooms/$roomId', expression: 'auth.uid === $roomId && newData.exists()' },
      rtdb: {
        matchedPath: '/rooms/$roomId',
        matchedRule: 'auth.uid === $roomId && newData.exists()',
        pathVariableBindings: { $roomId: 'alice' },
      },
    });
    expect(liveRuleEvaluation(rtdbWrite, RTDB_RULES_JSON)).toBeUndefined();
    expect(opensLiveRulesInspector(rtdbWrite)).toBe(true);
    const rtdbInspection = liveUnevaluatedInspection(rtdbWrite, RTDB_RULES_JSON);
    expect(rtdbInspection).toMatchObject({
      service: 'rtdb',
      method: 'set',
      rawMethod: 'set',
      path: '/rooms/alice',
      gaps: [{ gap: 'write-data', label: 'write-data (newData)' }],
      ruleContext: {
        engine: 'rtdb',
        nodeLabel: '/rooms/$roomId .write',
        line: 7,
        expression: 'auth.uid === $roomId && newData.exists()',
        pathVariableBindings: { $roomId: 'alice' },
      },
    });

    const firestoreSource = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    match /rooms/{room} {',
      '      allow read: if resource.data.public == true;',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const fsEvent = {
      ...rtdbLive('getDoc', 'rooms/r1', {
        result: 'unevaluated',
        needs: ['stored-document'],
        rule: { line: 5, expression: 'resource.data.public == true' },
      }),
      service: 'firestore',
    } as StudioTrafficEvent;
    const fsInspection = liveUnevaluatedInspection(fsEvent, firestoreSource);
    expect(fsInspection).toMatchObject({
      service: 'firestore',
      method: 'get',
      rawMethod: 'getDoc',
      gaps: [{ gap: 'stored-document', label: 'stored-document (resource / get / exists)' }],
      ruleContext: {
        engine: 'firestore',
        nodeLabel: 'allow read',
        line: 5,
        expression: 'resource.data.public == true',
      },
    });
  });

  it('keeps production-served RTDB rows in place and lets sandbox-served RTDB rows drill into /rtdb', () => {
    const sandboxServed = { service: 'rtdb', method: 'set', path: '/rooms/s1' } as const;
    expect(rowNavigationTarget(sandboxServed)).toEqual({ tab: 'rtdb' });
    expect(rowNavigationTarget({ ...sandboxServed, production: { outcome: { status: 'ok' } } })).toBeNull();
    expect(
      rowNavigationTarget({ service: 'firestore', method: 'getDoc', path: 'rooms/r1', production: { outcome: { status: 'ok' } } }),
    ).toEqual({ tab: 'firestore', rest: ['rooms', 'r1'] });
  });

  it('words each production outcome once in an unevaluated headline', () => {
    const local = { result: 'unevaluated', needs: ['write-data'] } as const;
    const headline = (outcome: { status: 'ok' } | { status: 'error'; code: string }) =>
      liveUnevaluatedInspection(rtdbLive('set', '/rooms/r1', local, outcome))?.headline;
    expect(headline({ status: 'ok' })).toMatch(/^Production allowed set on \/rooms\/r1\. /);
    expect(headline({ status: 'error', code: 'permission-denied' })).toMatch(/^Production denied set on \/rooms\/r1\. /);
    expect(headline({ status: 'error', code: 'unavailable' })).toMatch(/^Production failed set on \/rooms\/r1 \(unavailable\)\. /);
  });
});
