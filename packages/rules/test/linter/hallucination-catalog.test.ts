import { describe, test, expect } from 'bun:test';
import { lintFirestoreRules } from '../../src/linter/linter.js';

function wrap(condition: string, op = 'read'): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /things/{thingId} {
      allow ${op}: if ${condition};
    }
  }
}`;
}

function wrapFn(body: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function check() { return ${body}; }
    match /things/{thingId} {
      allow read: if check();
    }
  }
}`;
}

function lint(source: string) {
  return lintFirestoreRules(source);
}

function findings(result: ReturnType<typeof lintFirestoreRules>, rule: string) {
  return result.warnings.filter((w) => w.rule === rule);
}

describe('WRONG_CONTEXT_PATH', () => {
  test('catches request.data (missing .resource)', () => {
    const r = lint(wrap('request.data.foo == "bar"'));
    const f = findings(r, 'WRONG_CONTEXT_PATH');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0]?.message).toContain('request.resource.data');
  });

  test('catches request.uid (missing .auth)', () => {
    const r = lint(wrap('request.uid == thingId'));
    const f = findings(r, 'WRONG_CONTEXT_PATH');
    expect(f[0]?.message).toContain('request.auth.uid');
  });

  test('catches request.token (missing .auth)', () => {
    const r = lint(wrap('request.token.admin == true'));
    const f = findings(r, 'WRONG_CONTEXT_PATH');
    expect(f[0]?.message).toContain('request.auth.token');
  });

  test('catches resource.path', () => {
    const r = lint(wrap('resource.path == "things/x"'));
    expect(findings(r, 'WRONG_CONTEXT_PATH').length).toBeGreaterThan(0);
  });

  test('catches resource.exists used as boolean', () => {
    const r = lint(wrap('resource.exists && resource.data.foo == "bar"'));
    const f = findings(r, 'WRONG_CONTEXT_PATH');
    expect(f[0]?.message).toContain('resource != null');
  });

  test('catches resource.id', () => {
    const r = lint(wrap('resource.id == "x"'));
    expect(findings(r, 'WRONG_CONTEXT_PATH').length).toBeGreaterThan(0);
  });

  test('valid request.resource.data does not trigger', () => {
    const r = lint(wrap('request.resource.data.foo == "bar"'));
    expect(findings(r, 'WRONG_CONTEXT_PATH').length).toBe(0);
  });

  test('valid request.auth.uid does not trigger', () => {
    const r = lint(wrap('request.auth.uid == thingId'));
    expect(findings(r, 'WRONG_CONTEXT_PATH').length).toBe(0);
  });
});

describe('INVALID_PATH_INTERPOLATION', () => {
  test('flags get() with {var} interpolation', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /teams/{teamId}/docs/{docId} {
      allow read: if request.auth != null &&
        request.auth.uid in get(/databases/{database}/documents/teams/{teamId}).data.members;
    }
  }
}`;
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(2);
    const messages = w.map((x) => x.message).join(' | ');
    expect(messages).toContain('{database}');
    expect(messages).toContain('{teamId}');
    expect(messages).toContain('$(database)');
    expect(messages).toContain('$(teamId)');
    expect(w.every((x) => x.severity === 'error')).toBe(true);
  });

  test('passes cleanly when get() uses $(var) interpolation', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /teams/{teamId} {
      allow read: if request.auth.uid in
        get(/databases/$(database)/documents/teams/$(teamId)).data.members;
    }
  }
}`;
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    expect(findings(r, 'INVALID_PATH_INTERPOLATION').length).toBe(0);
  });

  test('flags only the {var} segments in a mixed-syntax path', () => {
    const source = wrap(
      'request.auth.uid in get(/databases/$(database)/documents/users/{userId}).data.peers',
    );
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(1);
    expect(w[0]?.message).toContain('{userId}');
    expect(w[0]?.message).toContain('$(userId)');
  });

  test('flags exists() with {var} interpolation', () => {
    const source = wrap(
      'exists(/databases/{database}/documents/teams/{teamId}/members/$(request.auth.uid))',
    );
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(2);
  });

  test('flags getAfter() with {var} interpolation', () => {
    const source = wrap(
      'getAfter(/databases/{database}/documents/orders/$(orderId)).data.status == "submitted"',
    );
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(1);
    expect(w[0]?.message).toContain('{database}');
  });

  test('flags existsAfter() with {var} interpolation', () => {
    const source = wrap(
      'existsAfter(/databases/$(database)/documents/locks/{lockId})',
    );
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(1);
    expect(w[0]?.message).toContain('{lockId}');
  });

  test('diagnostic teaches the match-vs-interpolation distinction', () => {
    const source = wrap('get(/databases/{database}/documents/x/y).data.z');
    const r = lint(source);
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(1);
    expect(w[0]?.message).toMatch(/match/i);
    expect(w[0]?.message).toMatch(/wildcard/i);
    expect(w[0]?.message).toMatch(/interpolation/i);
    expect(w[0]?.fix).toContain('$(');
  });

  test('blocks deploy via writeHandler -- severity is error', () => {
    const source = wrap('exists(/databases/{database}/documents/x/y)');
    const r = lint(source);
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(1);
    expect(w[0]?.severity).toBe('error');
  });

  test('does not flag literal path segments containing no braces', () => {
    const source = wrap('get(/databases/abc/documents/users/userid).data.x');
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    expect(findings(r, 'INVALID_PATH_INTERPOLATION').length).toBe(0);
  });
});

describe('BOOL_TOKEN_CLAIM', () => {
  test('catches email_verified == "true"', () => {
    const r = lint(wrap('request.auth.token.email_verified == "true"'));
    const f = findings(r, 'BOOL_TOKEN_CLAIM');
    expect(f.length).toBe(1);
    expect(f[0]?.severity).toBe('error');
    expect(f[0]?.message).toContain('email_verified');
    expect(f[0]?.message).toContain('bool');
  });

  test('catches != comparison (the always-true security hole)', () => {
    const r = lint(wrap('request.auth.token.email_verified != "true"'));
    const f = findings(r, 'BOOL_TOKEN_CLAIM');
    expect(f.length).toBe(1);
    expect(f[0]?.message).toContain('always true');
  });

  test('catches reversed operand order', () => {
    const r = lint(wrap('"true" == request.auth.token.email_verified'));
    expect(findings(r, 'BOOL_TOKEN_CLAIM').length).toBe(1);
  });

  test('catches the "false" string too', () => {
    const r = lint(wrap('request.auth.token.email_verified == "false"'));
    expect(findings(r, 'BOOL_TOKEN_CLAIM').length).toBe(1);
  });

  test('fires inside function bodies', () => {
    const r = lint(wrapFn('request.auth.token.email_verified == "true"'));
    expect(findings(r, 'BOOL_TOKEN_CLAIM').length).toBe(1);
  });

  test('boolean-literal comparison does not trigger', () => {
    const r = lint(wrap('request.auth.token.email_verified == true'));
    expect(findings(r, 'BOOL_TOKEN_CLAIM').length).toBe(0);
  });

  test('string claims are not flagged (sign_in_provider is a string)', () => {
    const r = lint(wrap("request.auth.token.firebase.sign_in_provider == 'password'"));
    expect(findings(r, 'BOOL_TOKEN_CLAIM').length).toBe(0);
  });

  test('a user field named email_verified outside request.auth.token is not flagged', () => {
    const r = lint(wrap('resource.data.email_verified == "true"'));
    expect(findings(r, 'BOOL_TOKEN_CLAIM').length).toBe(0);
  });
});

describe('ST-LNT-5: Storage hallucinations and 3-segment wrong context paths', () => {
  test('flags request.auth.id, resource.data, request.resource.data, and resource.timeUpdated in Storage rules, and avoids recommending request.resource.data', () => {
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow read: if request.auth != null
        && request.auth.id == resource.data.ownerId
        && resource.timeUpdated == request.time;
      allow write: if request.auth != null
        && request.resource.data.ownerId == request.auth.uid;
    }
    match /bad/{fileId} {
      allow write: if request.auth != null && request.data.owner == request.auth.uid;
    }
    match /open/{fileId} {
      allow write: if true;
    }
  }
}`;
    const r = lintFirestoreRules(storageRules);
    const wrongPaths = findings(r, 'WRONG_CONTEXT_PATH');
    expect(wrongPaths.some((w) => w.message.startsWith('`resource.data`'))).toBe(true);
    expect(wrongPaths.some((w) => w.message.startsWith('`request.resource.data`'))).toBe(true);
    expect(wrongPaths.some((w) => w.message.includes('timeUpdated'))).toBe(true);
    expect(wrongPaths.some((w) => w.message.startsWith('`request.auth.id`'))).toBe(true);

    const reqDataFix = wrongPaths.find((w) => w.message.startsWith('`request.data`'))?.fix ?? '';
    const permissiveFix = findings(r, 'PERMISSIVE_RULE')[0]?.fix ?? '';
    expect(reqDataFix).not.toContain('request.resource.data');
    expect(permissiveFix).not.toContain('request.resource.data');
  });

  test('does not flag resource.size or request.resource.size as METHOD_MISSING_PARENS in Storage rules', () => {
    const storageRules = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{fileId} {
      allow write: if request.auth != null
        && request.resource.size < 1048576
        && (resource == null || resource.size > 0);
    }
  }
}`;
    const r = lintFirestoreRules(storageRules);
    expect(findings(r, 'METHOD_MISSING_PARENS')).toHaveLength(0);
  });
});
