import { describe, expect, test } from 'bun:test';
import {
  evaluateStorageRules,
  parseStorageRules,
  type StorageEvaluationObservation,
} from '../../../src/storage/index.js';

function emptyStorageObservation(): StorageEvaluationObservation {
  return {
    readResource: false,
    readRequestResource: false,
    readFirestore: false,
    readAuthToken: false,
    readAuthTokenEmail: false,
  };
}

describe('evaluateStorageRules email-claim observation across firebase.identities and map methods', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const redactedToken = {
    email_verified: true,
    role: 'editor',
    firebase: {
      sign_in_provider: 'password',
      identities: {},
    },
  };

  function observeRead(condition: string): StorageEvaluationObservation {
    const source = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /items/{id} {',
      `      allow get: if request.auth != null && (${condition});`,
      '    }',
      '  }',
      '}',
    ].join('\n');
    const obs = emptyStorageObservation();
    evaluateStorageRules(
      parseStorageRules(source),
      {
        request: {
          auth: { uid: 'u-1', token: redactedToken },
          method: 'get',
          path: 'b/my-bucket/o/items/item-1',
        },
        resource: null,
      },
      now,
      undefined,
      obs,
    );
    return obs;
  }

  test('sets readAuthTokenEmail when reading firebase.identities.email via in, member, or index', () => {
    expect(observeRead("'email' in request.auth.token.firebase.identities").readAuthTokenEmail).toBe(true);
    expect(observeRead("request.auth.token.firebase.identities.email[0] == 'u1@example.org'").readAuthTokenEmail).toBe(
      true,
    );
    expect(observeRead("request.auth.token['firebase']['identities']['email'] != null").readAuthTokenEmail).toBe(true);
  });

  test('sets readAuthTokenEmail when reading email via Map.get string key or nested key path', () => {
    expect(observeRead("request.auth.token.get('email', '') == 'u1@example.org'").readAuthTokenEmail).toBe(true);
    expect(
      observeRead("request.auth.token.get(['firebase', 'identities', 'email'], []).size() > 0").readAuthTokenEmail,
    ).toBe(true);
    expect(
      observeRead("request.auth.token.firebase.identities.get('email', []).size() > 0").readAuthTokenEmail,
    ).toBe(true);
  });

  test('sets readAuthTokenEmail when enumerating or comparing token or firebase.identities maps', () => {
    expect(observeRead("'email' in request.auth.token.keys()").readAuthTokenEmail).toBe(true);
    expect(observeRead("'u1@example.org' in request.auth.token.values()").readAuthTokenEmail).toBe(true);
    expect(observeRead('request.auth.token.size() > 0').readAuthTokenEmail).toBe(true);
    expect(observeRead('request.auth.token.diff({}).addedKeys().size() > 0').readAuthTokenEmail).toBe(true);
    expect(observeRead('request.auth.token.firebase.identities.keys().size() > 0').readAuthTokenEmail).toBe(true);
    expect(observeRead('request.auth.token == {}').readAuthTokenEmail).toBe(true);
  });

  test('leaves readAuthTokenEmail false for non-email claims and null checks', () => {
    const roleObs = observeRead(
      "request.auth.token != null && request.auth.token.role == 'editor' && !('phone' in request.auth.token.firebase.identities) && request.auth.token.get('role', '') == 'editor'",
    );
    expect(roleObs.readAuthToken).toBe(true);
    expect(roleObs.readAuthTokenEmail).toBe(false);
  });
});
