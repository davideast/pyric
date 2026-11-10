import { describe, expect, it } from 'bun:test';
import type { ObservedCall } from 'pyric/sandbox';
import { givenBy, unionPaths, verdictOf } from '../../../../src/serve/worker/host/observe-local-evaluation.js';

const BASE_CALL: ObservedCall = {
  service: 'rtdb',
  method: 'get',
  path: '/items/item-1',
  at: 1_700_000_000_000,
  outcome: { status: 'ok' },
  account: { uid: 'u-1' },
};

describe('observe-local-evaluation (#2540)', () => {
  it('sorts and deduplicates missingPaths while ignoring blanks (#2540 F7)', () => {
    expect(unionPaths(['/items/c', '', '/items/a'], ['/items/b', '/items/a'])).toEqual([
      '/items/a',
      '/items/b',
      '/items/c',
    ]);
  });

  it('attaches bounded missingPaths to unevaluated verdicts and omits empty lists', () => {
    const withPaths = verdictOf(BASE_CALL, {
      allowed: false,
      rule: { path: '/items/$id', expression: "root.child('flags/open').val() === true" },
      needs: ['stored-document'],
      missingPaths: ['/flags/open', '/flags/open'],
    });
    expect(withPaths).toEqual({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['/flags/open'],
      rule: { path: '/items/$id', expression: "root.child('flags/open').val() === true" },
    });

    const withoutPaths = verdictOf(BASE_CALL, {
      allowed: false,
      rule: undefined,
      needs: ['query'],
      missingPaths: [],
    });
    expect(withoutPaths).toEqual({
      result: 'unevaluated',
      needs: ['query'],
    });
  });

  it('treats signed-out calls as having complete claim and email knowledge while signed-in calls without claims stay open', () => {
    const signedOut: ObservedCall = {
      service: 'firestore',
      method: 'getDoc',
      path: 'docs/d1',
      at: 1_700_000_000_000,
      outcome: { status: 'ok' },
    };
    expect(givenBy(signedOut, 'get')).toMatchObject({
      claims: true,
      emailKnown: true,
    });

    expect(givenBy(BASE_CALL, 'get')).toMatchObject({
      claims: false,
      emailKnown: false,
    });
  });

  it('reports local rules, bindings, reasons, missing paths, and traces verbatim', () => {
    const opaque = 'tok_0123456789abcdef0123456789abcdef01234567';

    const unevaluated = verdictOf(BASE_CALL, {
      allowed: false,
      rule: { path: '/orgs/$orgId/tokens/$token', expression: 'auth.token.role === "admin"' },
      needs: ['claim-values', 'stored-document'],
      missingPaths: [`/orgs/org-1/tokens/${opaque}`],
      rtdb: {
        matchedPath: '/orgs/$orgId/tokens/$token',
        matchedRule: 'auth.token.role === "admin"',
        pathVariableBindings: { $orgId: 'org-1', $token: opaque },
        reason: `Denied at /orgs/org-1/tokens/${opaque}`,
      },
    });
    expect(unevaluated).toEqual({
      result: 'unevaluated',
      needs: ['claim-values', 'stored-document'],
      missingPaths: [`/orgs/org-1/tokens/${opaque}`],
      rule: { path: '/orgs/$orgId/tokens/$token', expression: 'auth.token.role === "admin"' },
      rtdb: {
        matchedPath: '/orgs/$orgId/tokens/$token',
        matchedRule: 'auth.token.role === "admin"',
        pathVariableBindings: { $orgId: 'org-1', $token: opaque },
      },
    });

    const decidedStorage = verdictOf(BASE_CALL, {
      allowed: false,
      rule: undefined,
      needs: [],
      storage: {
        matchedPath: 'match /items/{id}',
        reasons: [`Denied get on /items/${opaque}`],
      },
    });
    expect(decidedStorage).toEqual({
      result: 'deny',
      drift: true,
      storage: {
        matchedPath: 'match /items/{id}',
        reasons: [`Denied get on /items/${opaque}`],
      },
    });

    const trace = {
      rulesVersion: 'local-rules',
      scope: 'request',
      rules: [
        {
          method: 'get',
          expression: 'resource.data.apiToken == request.auth.token.apiToken',
          verdict: 'ALLOW',
          checks: [
            {
              index: 0,
              parent: null,
              kind: 'memberAccess',
              expression: 'resource.data.apiToken',
              state: 'value',
              value: opaque,
            },
          ],
        },
      ],
      paths: [{ path: `docs/${opaque}`, outcome: 'matched' }],
    } as const;
    const decidedTrace = verdictOf(BASE_CALL, {
      allowed: true,
      rule: { line: 4, expression: 'resource.data.apiToken == request.auth.token.apiToken' },
      needs: [],
      trace: structuredClone(trace) as never,
    });
    expect(decidedTrace).toEqual({
      result: 'allow',
      rule: { line: 4, expression: 'resource.data.apiToken == request.auth.token.apiToken' },
      trace,
    });
  });
});
