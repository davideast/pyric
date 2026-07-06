import { describe, expect, test } from 'bun:test';
import { PYRIC_SESSIONS_RULE, injectPyricRule } from './storage-rules';

describe('storage rules pyric_sessions injection', () => {
  test('canonical rule allows legacy session objects and nested export artifacts', () => {
    expect(PYRIC_SESSIONS_RULE).toContain('match /pyric_sessions/{userId}/{sessionId}');
    expect(PYRIC_SESSIONS_RULE).toContain('match /pyric_sessions/{userId}/{sessionId}/{rest=**}');
    expect(PYRIC_SESSIONS_RULE).toContain('request.auth.uid == userId');
  });

  test('inserts nested canonical rule into an existing ruleset', () => {
    const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /public/{file} {
      allow read: if true;
    }
  }
}
`;

    const next = injectPyricRule(source);

    expect(next).not.toBeNull();
    expect(next).toContain(PYRIC_SESSIONS_RULE);
    expect(next).toContain('match /public/{file}');
  });

  test('replaces an older single-object pyric_sessions block', () => {
    const source = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_sessions/{userId}/{sessionId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
`;

    const next = injectPyricRule(source);

    expect(next).not.toBeNull();
    expect(next).toContain('match /pyric_sessions/{userId}/{sessionId}/{rest=**}');
    expect(next!.match(/match \/pyric_sessions/g)?.length).toBe(2);
  });
});
