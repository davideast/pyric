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

  it('scrubs tokens and secret bindings in decided and unevaluated verdicts', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJ1c2VyLTEifQ.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const apiKey = ['AIza', 'SyDummyKey0123456789abcdef012345678'].join('');
    const oauthToken = ['ya29', '.a0DummyOAuth0123456789abcdef'].join('');
    const refreshToken = ['1//', '0gDummyRefreshToken0123456789abcdef'].join('');
    const opaque = 'tok_0123456789abcdef0123456789abcdef01234567';

    const unevaluated = verdictOf(BASE_CALL, {
      allowed: false,
      rule: { path: '/orgs/$orgId/tokens/$token', expression: 'auth.token.role === "admin"' },
      needs: ['claim-values', 'stored-document'],
      missingPaths: [`/orgs/org-1/tokens/${opaque}`, `/keys/${apiKey}`],
      rtdb: {
        matchedPath: '/orgs/$orgId/tokens/$token',
        matchedRule: 'auth.token.role === "admin"',
        pathVariableBindings: {
          $orgId: 'org-1',
          $token: 'short-secret-value',
        },
        reason: `Denied at /orgs/org-1/tokens/${opaque}`,
      },
    });
    const unevalJson = JSON.stringify(unevaluated);
    expect(unevalJson).not.toContain(opaque);
    expect(unevalJson).not.toContain(apiKey);
    expect(unevalJson).not.toContain('short-secret-value');
    expect(unevaluated).toMatchObject({
      result: 'unevaluated',
      rtdb: {
        pathVariableBindings: {
          $orgId: 'org-1',
          $token: '[redacted]',
        },
      },
    });

    const decidedStorage = verdictOf(BASE_CALL, {
      allowed: false,
      rule: undefined,
      needs: [],
      storage: {
        matchedPath: 'match /items/{id}',
        reasons: [
          `Denied get on /items/${jwt}`,
          `Bearer ${oauthToken} refresh=${refreshToken} key=${apiKey}`,
        ],
      },
    });
    const storageJson = JSON.stringify(decidedStorage);
    expect(storageJson).not.toContain(jwt);
    expect(storageJson).not.toContain(oauthToken);
    expect(storageJson).not.toContain(refreshToken);
    expect(storageJson).not.toContain(apiKey);

    const sha256Hex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const nonSecretTrace = verdictOf(BASE_CALL, {
      allowed: true,
      rule: { line: 4, expression: 'resource.data.tokenCount == "12"' },
      needs: [],
      trace: {
        rulesVersion: 'local-rules',
        scope: 'request',
        rules: [
          {
            method: 'get',
            expression: 'resource.data.tokenCount == "12"',
            verdict: 'ALLOW',
            checks: [
              {
                index: 0,
                parent: null,
                kind: 'memberAccess',
                expression: 'resource.data.tokenCount',
                state: 'value',
                value: '12',
              },
              {
                index: 1,
                parent: null,
                kind: 'memberAccess',
                expression: 'resource.data.nextPageToken',
                state: 'value',
                value: 'cursor-page-2',
              },
              {
                index: 2,
                parent: null,
                kind: 'memberAccess',
                expression: 'resource.data.sha256',
                state: 'value',
                value: sha256Hex,
              },
            ],
          },
        ],
        paths: [{ path: `docs/${sha256Hex}`, outcome: 'matched' }],
      },
    });
    expect(nonSecretTrace).toMatchObject({
      result: 'allow',
      trace: {
        rules: [
          {
            checks: [{ value: '12' }, { value: 'cursor-page-2' }, { value: sha256Hex }],
          },
        ],
        paths: [{ path: `docs/${sha256Hex}` }],
      },
    });
  });
});
