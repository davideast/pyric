import { describe, test, expect } from 'bun:test';
import { lintFirestoreRules } from '../../../src/rules/linter/linter.js';
import { checkSyntaxHints, checkHallucinations } from '../../../src/rules/linter/hallucinations.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';

// ─── Test helpers ─────────────────────────────────────────────────────

function wrap(condition: string, op: string = 'read'): string {
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
  return result.warnings.filter(w => w.rule === rule);
}

// ─── Pre-parse syntax hints ───────────────────────────────────────────

describe('checkSyntaxHints', () => {
  test('flags strict equality ===', () => {
    const w = checkSyntaxHints('allow read: if a === b;');
    expect(w.length).toBe(1);
    expect(w[0].rule).toBe('INVALID_OPERATOR');
    expect(w[0].message).toContain('===');
  });

  test('flags strict inequality !==', () => {
    const w = checkSyntaxHints('allow read: if a !== b;');
    expect(w[0].message).toContain('!==');
  });

  test('flags optional chaining ?.', () => {
    const w = checkSyntaxHints('allow read: if a?.b == 1;');
    expect(w[0].message).toContain('?.');
  });

  test('flags nullish coalescing ??', () => {
    const w = checkSyntaxHints('allow read: if (a ?? b) == 1;');
    expect(w[0].message).toContain('??');
  });

  test('flags arrow functions =>', () => {
    const w = checkSyntaxHints('function f() { return (x) => x + 1; }');
    expect(w[0].message).toContain('=>');
  });

  test('flags backtick strings', () => {
    const w = checkSyntaxHints('allow read: if name == `hello`;');
    expect(w[0].message).toContain('Backtick');
  });

  test('ignores operators inside line comments', () => {
    const w = checkSyntaxHints('// example: a === b\nallow read: if a == b;');
    expect(w.length).toBe(0);
  });

  test('ignores operators inside block comments', () => {
    const w = checkSyntaxHints('/* a === b */\nallow read: if a == b;');
    expect(w.length).toBe(0);
  });

  test('clean source produces no syntax warnings', () => {
    const w = checkSyntaxHints('allow read: if a == b;');
    expect(w.length).toBe(0);
  });
});

// ─── HALLUCINATED_METHOD ──────────────────────────────────────────────

describe('HALLUCINATED_METHOD', () => {
  test('catches .where() on data', () => {
    const r = lint(wrap('request.resource.data.where(x, x.active).size() > 0'));
    const f = findings(r, 'HALLUCINATED_METHOD');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].severity).toBe('error');
    expect(f[0].message).toContain('where');
  });

  test('catches .filter()', () => {
    const r = lint(wrap('request.resource.data.items.filter(x, x > 0).size() > 0'));
    expect(findings(r, 'HALLUCINATED_METHOD').length).toBeGreaterThan(0);
  });

  test('catches .includes() with hint to use `in`', () => {
    const r = lint(wrap('request.resource.data.tags.includes("admin")'));
    const f = findings(r, 'HALLUCINATED_METHOD');
    expect(f[0].message).toContain('in list');
  });

  test('catches .map() and .reduce()', () => {
    const r1 = lint(wrap('request.resource.data.items.map(x, x.name).size() > 0'));
    const r2 = lint(wrap('request.resource.data.items.reduce(0, x).size() > 0'));
    expect(findings(r1, 'HALLUCINATED_METHOD').length).toBeGreaterThan(0);
    expect(findings(r2, 'HALLUCINATED_METHOD').length).toBeGreaterThan(0);
  });

  test('catches .toLowerCase() with hint to use .lower()', () => {
    const r = lint(wrap('request.resource.data.name.toLowerCase() == "alice"'));
    const f = findings(r, 'HALLUCINATED_METHOD');
    expect(f[0].message).toContain('.lower()');
  });

  test('catches .toUpperCase() with hint to use .upper()', () => {
    const r = lint(wrap('request.resource.data.name.toUpperCase() == "ALICE"'));
    const f = findings(r, 'HALLUCINATED_METHOD');
    expect(f[0].message).toContain('.upper()');
  });

  test('catches array mutation methods', () => {
    const r = lint(wrap('request.resource.data.items.push("x").size() > 0'));
    expect(findings(r, 'HALLUCINATED_METHOD').length).toBeGreaterThan(0);
  });

  test('valid CEL methods produce no warnings', () => {
    const r = lint(wrap('request.resource.data.tags.hasAll(["admin"]) && request.resource.data.name.lower() == "alice"'));
    expect(findings(r, 'HALLUCINATED_METHOD').length).toBe(0);
  });

  test('detects inside function bodies', () => {
    const r = lint(wrapFn('request.resource.data.items.filter(x, x > 0).size() > 0'));
    expect(findings(r, 'HALLUCINATED_METHOD').length).toBeGreaterThan(0);
  });
});

// ─── HALLUCINATED_GLOBAL ──────────────────────────────────────────────

describe('HALLUCINATED_GLOBAL', () => {
  test('catches Object.keys()', () => {
    const r = lint(wrap('Object.keys(request.resource.data).size() > 0'));
    const f = findings(r, 'HALLUCINATED_GLOBAL');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].message).toContain('Object');
    expect(f[0].message).toContain('data.keys()');
  });

  test('catches JSON.parse()', () => {
    const r = lint(wrap('JSON.parse(request.resource.data.payload).valid == true'));
    const f = findings(r, 'HALLUCINATED_GLOBAL');
    expect(f[0].message).toContain('JSON');
  });

  test('catches Math.max()', () => {
    const r = lint(wrap('Math.max(request.resource.data.a, request.resource.data.b) > 100'));
    const f = findings(r, 'HALLUCINATED_GLOBAL');
    expect(f[0].message).toContain('Math');
  });

  test('catches Date.now()', () => {
    const r = lint(wrap('Date.now() > request.resource.data.createdAt'));
    const f = findings(r, 'HALLUCINATED_GLOBAL');
    expect(f[0].message).toContain('Date');
    expect(f[0].message).toContain('request.time');
  });

  test('catches parseInt() as bare function', () => {
    const r = lint(wrap('parseInt(request.resource.data.count) > 0'));
    const f = findings(r, 'HALLUCINATED_GLOBAL');
    expect(f[0].message).toContain('parseInt');
    expect(f[0].message).toContain('int(x)');
  });

  test('catches isNaN() as bare function', () => {
    const r = lint(wrap('!isNaN(request.resource.data.score)'));
    expect(findings(r, 'HALLUCINATED_GLOBAL').length).toBeGreaterThan(0);
  });

  test('catches String() constructor (capital S)', () => {
    const r = lint(wrap('String(request.resource.data.count) == "5"'));
    const f = findings(r, 'HALLUCINATED_GLOBAL');
    expect(f[0].message).toContain('String');
    expect(f[0].message).toContain('string(x)');
  });

  test('lowercase string() cast does not trigger', () => {
    const r = lint(wrap('string(request.resource.data.count) == "5"'));
    expect(findings(r, 'HALLUCINATED_GLOBAL').length).toBe(0);
  });
});

// ─── WRONG_CONTEXT_PATH ───────────────────────────────────────────────

describe('WRONG_CONTEXT_PATH', () => {
  test('catches request.data (missing .resource)', () => {
    const r = lint(wrap('request.data.foo == "bar"'));
    const f = findings(r, 'WRONG_CONTEXT_PATH');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].message).toContain('request.resource.data');
  });

  test('catches request.uid (missing .auth)', () => {
    const r = lint(wrap('request.uid == thingId'));
    const f = findings(r, 'WRONG_CONTEXT_PATH');
    expect(f[0].message).toContain('request.auth.uid');
  });

  test('catches request.token (missing .auth)', () => {
    const r = lint(wrap('request.token.admin == true'));
    const f = findings(r, 'WRONG_CONTEXT_PATH');
    expect(f[0].message).toContain('request.auth.token');
  });

  test('catches resource.path', () => {
    const r = lint(wrap('resource.path == "things/x"'));
    expect(findings(r, 'WRONG_CONTEXT_PATH').length).toBeGreaterThan(0);
  });

  test('catches resource.exists used as boolean', () => {
    const r = lint(wrap('resource.exists && resource.data.foo == "bar"'));
    const f = findings(r, 'WRONG_CONTEXT_PATH');
    expect(f[0].message).toContain('resource != null');
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

// ─── LENGTH_PROPERTY ──────────────────────────────────────────────────

describe('LENGTH_PROPERTY', () => {
  test('flags .length on a method-call result (definitely JS)', () => {
    const r = lint(wrap('request.resource.data.name.split(",").length > 0'));
    const f = findings(r, 'LENGTH_PROPERTY');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].severity).toBe('error');
    expect(f[0].message).toContain('.size()');
  });

  test('does NOT flag .length on plain data field (could be a real field name)', () => {
    const r = lint(wrap('request.resource.data.length > 0'));
    expect(findings(r, 'LENGTH_PROPERTY').length).toBe(0);
  });

  test('valid .size() on split result does not trigger', () => {
    const r = lint(wrap('request.resource.data.name.split(",").size() > 0'));
    expect(findings(r, 'LENGTH_PROPERTY').length).toBe(0);
  });
});

// ─── METHOD_MISSING_PARENS ────────────────────────────────────────────

describe('METHOD_MISSING_PARENS', () => {
  test('flags data.size on request data (warning, not error)', () => {
    const r = lint(wrap('request.resource.data.size > 0'));
    const f = findings(r, 'METHOD_MISSING_PARENS');
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].severity).toBe('warning');
    expect(f[0].message).toContain('.size()');
  });

  test('flags data.keys on request data', () => {
    const r = lint(wrap('"name" in request.resource.data.keys'));
    expect(findings(r, 'METHOD_MISSING_PARENS').length).toBeGreaterThan(0);
  });

  test('flags data.lower on a member-access chain', () => {
    const r = lint(wrap('request.resource.data.name.lower == "alice"'));
    expect(findings(r, 'METHOD_MISSING_PARENS').length).toBeGreaterThan(0);
  });

  test('valid .size() with parens does not trigger', () => {
    const r = lint(wrap('request.resource.data.size() > 0'));
    expect(findings(r, 'METHOD_MISSING_PARENS').length).toBe(0);
  });
});

// ─── Integration via lintFirestoreRules ───────────────────────────────

describe('integration: lintFirestoreRules surfaces hallucinations', () => {
  test('valid clean rules produce no hallucination warnings', () => {
    const r = lint(wrap('request.auth != null && request.auth.uid == thingId'));
    const halls = r.warnings.filter(w =>
      ['HALLUCINATED_METHOD', 'HALLUCINATED_GLOBAL', 'WRONG_CONTEXT_PATH', 'LENGTH_PROPERTY', 'METHOD_MISSING_PARENS', 'INVALID_OPERATOR']
        .includes(w.rule));
    expect(halls.length).toBe(0);
  });

  test('multi-issue source surfaces all categories', () => {
    const source = wrap('request.data.items.filter(x, x > 0).size() > 0 && Object.keys(request.resource.data).size() > 0');
    const r = lint(source);
    expect(findings(r, 'HALLUCINATED_METHOD').length).toBeGreaterThan(0);
    expect(findings(r, 'HALLUCINATED_GLOBAL').length).toBeGreaterThan(0);
    expect(findings(r, 'WRONG_CONTEXT_PATH').length).toBeGreaterThan(0);
  });

  test('pre-parse hint fires even when full source has parse errors', () => {
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /x/{id} {
      allow read: if a === b;  // === also breaks the parser
    }
  }
}`;
    const r = lint(source);
    expect(findings(r, 'INVALID_OPERATOR').length).toBeGreaterThan(0);
  });
});

// ─── Direct AST-only check ────────────────────────────────────────────

describe('checkHallucinations (AST only)', () => {
  test('returns empty array on clean AST', () => {
    const ast = parseToAST(wrap('request.auth != null'));
    expect(ast).not.toBeNull();
    const w = checkHallucinations(ast!);
    expect(w.length).toBe(0);
  });

  test('returns location info with matchPath', () => {
    const ast = parseToAST(wrap('request.resource.data.where(x, x.active).size() > 0'));
    const w = checkHallucinations(ast!);
    expect(w[0].location?.matchPath).toContain('things');
  });
});

// ─── INVALID_PATH_INTERPOLATION ───────────────────────────────────────
//
// Agents commonly confuse two distinct path syntaxes:
//   - Match paths use `{var}` for capture: match /users/{userId}
//   - Path literals (in get/exists/getAfter/existsAfter) use `$(var)`
//     for interpolation: get(/databases/$(database)/documents/...)
//
// Real Firestore REJECTS `{var}` inside get()/exists() paths at deploy.
// Before this rule, the parser fell back to a MapLiteral attempt and
// produced an opaque `Expected ":"` error pointing at the closing brace
// — agents iterating on linter feedback could not recover. The grammar
// now parses `{ident}` as a valid path segment so the linter can emit
// a precise INVALID_PATH_INTERPOLATION diagnostic that names the
// match-vs-interpolation distinction.

describe('INVALID_PATH_INTERPOLATION', () => {
  test('flags get() with {var} interpolation (the pilot iter-4 input)', () => {
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
    const messages = w.map(x => x.message).join(' | ');
    expect(messages).toContain('{database}');
    expect(messages).toContain('{teamId}');
    expect(messages).toContain('$(database)');
    expect(messages).toContain('$(teamId)');
    expect(w.every(x => x.severity === 'error')).toBe(true);
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
    expect(w[0].message).toContain('{userId}');
    expect(w[0].message).toContain('$(userId)');
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
    expect(w[0].message).toContain('{database}');
  });

  test('flags existsAfter() with {var} interpolation', () => {
    const source = wrap(
      'existsAfter(/databases/$(database)/documents/locks/{lockId})',
    );
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(1);
    expect(w[0].message).toContain('{lockId}');
  });

  test('diagnostic teaches the match-vs-interpolation distinction', () => {
    const source = wrap('get(/databases/{database}/documents/x/y).data.z');
    const r = lint(source);
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(1);
    // The diagnostic must name the *why* — agents pick the wrong syntax
    // because match wildcards and path interpolation look similar.
    expect(w[0].message).toMatch(/match/i);
    expect(w[0].message).toMatch(/wildcard/i);
    expect(w[0].message).toMatch(/interpolation/i);
    // And must give the concrete fix.
    expect(w[0].fix).toContain('$(');
  });

  test('blocks deploy via writeHandler — severity is error', () => {
    const source = wrap('exists(/databases/{database}/documents/x/y)');
    const r = lint(source);
    const w = findings(r, 'INVALID_PATH_INTERPOLATION');
    expect(w.length).toBe(1);
    expect(w[0].severity).toBe('error');
  });

  test('does not flag literal path segments containing braces nowhere', () => {
    const source = wrap('get(/databases/abc/documents/users/userid).data.x');
    const r = lint(source);
    expect(r.parseError).toBeUndefined();
    expect(findings(r, 'INVALID_PATH_INTERPOLATION').length).toBe(0);
  });
});

// ─── debug() rejection (T2.4A) ────────────────────────────────────────
//
// Production Firestore rejects debug() at compile time
// ("Function not found error: Name: [debug]"). The linter must reject it
// by default — including when the caller supplies testCases, which used
// to silently imply allowDebug and disable the check in exactly the
// lint-with-suite authoring path that feeds the write gate.

describe('debug() rejection', () => {
  const debugSource = wrap('debug(request.auth != null)');
  const tc = {
    description: 'read thing',
    expectation: 'ALLOW' as const,
    method: 'get' as const,
    path: 'things/a',
    auth: { uid: 'u' },
  };

  test('rejects debug() by default (error severity)', () => {
    const r = lint(debugSource);
    const f = findings(r, 'HALLUCINATED_GLOBAL').filter(w => w.message.includes('debug'));
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe('error');
  });

  test('still rejects debug() when testCases are supplied (no implicit opt-out)', () => {
    const r = lintFirestoreRules(debugSource, { testCases: [tc] });
    const f = findings(r, 'HALLUCINATED_GLOBAL').filter(w => w.message.includes('debug'));
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe('error');
  });

  test('explicit allowDebug: true is the only opt-out', () => {
    const r = lintFirestoreRules(debugSource, { allowDebug: true, testCases: [tc] });
    const f = findings(r, 'HALLUCINATED_GLOBAL').filter(w => w.message.includes('debug'));
    expect(f.length).toBe(0);
  });
});

// ─── BOOL_TOKEN_CLAIM (T2.4D) ─────────────────────────────────────────

describe('BOOL_TOKEN_CLAIM', () => {
  test('catches email_verified == "true"', () => {
    const r = lint(wrap('request.auth.token.email_verified == "true"'));
    const f = findings(r, 'BOOL_TOKEN_CLAIM');
    expect(f.length).toBe(1);
    expect(f[0].severity).toBe('error');
    expect(f[0].message).toContain('email_verified');
    expect(f[0].message).toContain('bool');
  });

  test('catches != comparison (the always-true security hole)', () => {
    const r = lint(wrap('request.auth.token.email_verified != "true"'));
    const f = findings(r, 'BOOL_TOKEN_CLAIM');
    expect(f.length).toBe(1);
    expect(f[0].message).toContain('always true');
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
