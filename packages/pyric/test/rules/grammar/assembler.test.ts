import { describe, test, expect } from 'bun:test';
import { assembleExpression, assembleRules, assembleMatchBlock } from '../../../src/rules/grammar/FirestoreAssembler.js';
import type { Expression, FirestoreRules, MatchBlock } from '../../../src/rules/grammar/FirestoreAST.js';

// ---- AST builder helpers ----

const lit = (value: string | number | boolean | null, raw?: string): Expression =>
  ({ type: 'literal', value, raw: raw ?? String(value) });

const str = (value: string): Expression =>
  ({ type: 'literal', value, raw: `'${value}'` });

const dstr = (value: string): Expression =>
  ({ type: 'literal', value, raw: `"${value}"` });

const id = (name: string): Expression =>
  ({ type: 'identifier', name });

const member = (object: Expression, property: string): Expression =>
  ({ type: 'memberAccess', object, property });

const method = (object: Expression, name: string, args: Expression[] = []): Expression =>
  ({ type: 'methodCall', object, method: name, args });

const bracket = (object: Expression, index: Expression): Expression =>
  ({ type: 'bracketAccess', object, index });

const bin = (op: string, left: Expression, right: Expression): Expression =>
  ({ type: 'binaryOp', op, left, right });

const unary = (op: string, operand: Expression): Expression =>
  ({ type: 'unaryOp', op, operand });

const ternary = (condition: Expression, consequent: Expression, alternate: Expression): Expression =>
  ({ type: 'ternary', condition, consequent, alternate });

const inExpr = (element: Expression, collection: Expression): Expression =>
  ({ type: 'inExpr', element, collection });

const isExpr = (value: Expression, typeName: string): Expression =>
  ({ type: 'isExpr', value, typeName });

const list = (elements: Expression[]): Expression =>
  ({ type: 'listLiteral', elements });

const map = (entries: Array<{ key: Expression; value: Expression }>): Expression =>
  ({ type: 'mapLiteral', entries });

const path = (segments: Array<string | Expression>): Expression =>
  ({ type: 'pathLiteral', raw: '', segments });

const fn = (name: string, args: Expression[] = []): Expression =>
  ({ type: 'functionCall', name, args });

// Shorthand for deep member chains: m('request', 'auth', 'uid')
const m = (...parts: string[]): Expression =>
  parts.slice(1).reduce<Expression>((obj, prop) => member(obj, prop), id(parts[0]));

// ---- Increment 1: Expressions ----

describe('assembleExpression', () => {
  describe('1a: atomic expressions', () => {
    test('true', () => expect(assembleExpression(lit(true))).toBe('true'));
    test('false', () => expect(assembleExpression(lit(false))).toBe('false'));
    test('null', () => expect(assembleExpression(lit(null))).toBe('null'));
    test('integer', () => expect(assembleExpression(lit(42, '42'))).toBe('42'));
    test('float', () => expect(assembleExpression(lit(3.14, '3.14'))).toBe('3.14'));
    test('single-quoted string', () => expect(assembleExpression(str('hello'))).toBe("'hello'"));
    test('double-quoted string normalized to single', () => expect(assembleExpression(dstr('hello'))).toBe("'hello'"));
    test('identifier', () => expect(assembleExpression(id('request'))).toBe('request'));
    test('empty string', () => expect(assembleExpression(str(''))).toBe("''"));
    test('zero', () => expect(assembleExpression(lit(0, '0'))).toBe('0'));
    test('string with backslash escapes preserved', () => {
      // Regex pattern like \\. should preserve the backslash in output
      const expr: Expression = { type: 'literal', value: '\\.', raw: "'\\\\\\.'", };
      expect(assembleExpression(expr)).toBe("'\\\\\\.'");
    });
  });

  describe('1b: member access and method calls', () => {
    test('simple member', () => {
      expect(assembleExpression(member(id('request'), 'auth'))).toBe('request.auth');
    });
    test('chained member', () => {
      expect(assembleExpression(m('request', 'auth', 'uid'))).toBe('request.auth.uid');
    });
    test('method call no args', () => {
      expect(assembleExpression(method(id('data'), 'keys'))).toBe('data.keys()');
    });
    test('method call with args', () => {
      expect(assembleExpression(
        method(id('data'), 'hasAll', [list([str('title'), str('body')])])
      )).toBe("data.hasAll(['title', 'body'])");
    });
    test('chained methods', () => {
      const expr = method(
        method(member(m('request', 'resource', 'data'), 'keys'), 'keys'),
        'hasOnly',
        [list([str('a')])]
      );
      // request.resource.data.keys.keys().hasOnly(['a']) — but let's do a more realistic one
      const realistic = method(
        method(m('request', 'resource', 'data'), 'keys'),
        'hasOnly',
        [list([str('a'), str('b')])]
      );
      expect(assembleExpression(realistic)).toBe("request.resource.data.keys().hasOnly(['a', 'b'])");
    });
  });

  describe('1c: bracket access', () => {
    test('string index', () => {
      expect(assembleExpression(bracket(id('data'), str('status')))).toBe("data['status']");
    });
    test('expression index', () => {
      expect(assembleExpression(bracket(id('data'), m('request', 'auth', 'uid')))).toBe('data[request.auth.uid]');
    });
  });

  describe('1d: binary operators', () => {
    test('not equal null', () => {
      expect(assembleExpression(bin('!=', m('request', 'auth'), lit(null)))).toBe('request.auth != null');
    });
    test('logical and', () => {
      expect(assembleExpression(bin('&&', id('a'), id('b')))).toBe('a && b');
    });
    test('logical or', () => {
      expect(assembleExpression(bin('||', id('a'), id('b')))).toBe('a || b');
    });
    test('addition', () => {
      expect(assembleExpression(bin('+', id('a'), lit(10, '10')))).toBe('a + 10');
    });
  });

  describe('1e: operator precedence', () => {
    test('(a || b) && c needs parens on left', () => {
      expect(assembleExpression(bin('&&', bin('||', id('a'), id('b')), id('c')))).toBe('(a || b) && c');
    });
    test('a && (b || c) needs parens on right', () => {
      expect(assembleExpression(bin('&&', id('a'), bin('||', id('b'), id('c'))))).toBe('a && (b || c)');
    });
    test('a && b && c left-assoc no parens', () => {
      expect(assembleExpression(bin('&&', bin('&&', id('a'), id('b')), id('c')))).toBe('a && b && c');
    });
    test('a + b * c no parens (higher precedence)', () => {
      expect(assembleExpression(bin('+', id('a'), bin('*', id('b'), id('c'))))).toBe('a + b * c');
    });
    test('(a + b) * c needs parens', () => {
      expect(assembleExpression(bin('*', bin('+', id('a'), id('b')), id('c')))).toBe('(a + b) * c');
    });
    test('a == b && c != d no parens (== higher than &&)', () => {
      expect(assembleExpression(
        bin('&&', bin('==', id('a'), id('b')), bin('!=', id('c'), id('d')))
      )).toBe('a == b && c != d');
    });
  });

  describe('1f: unary operators', () => {
    test('not', () => {
      expect(assembleExpression(unary('!', id('x')))).toBe('!x');
    });
    test('negation', () => {
      expect(assembleExpression(unary('-', lit(5, '5')))).toBe('-5');
    });
    test('not with lower-precedence operand', () => {
      expect(assembleExpression(unary('!', bin('||', id('a'), id('b'))))).toBe('!(a || b)');
    });
  });

  describe('1g: ternary, in, is', () => {
    test('ternary', () => {
      expect(assembleExpression(
        ternary(bin('!=', m('request', 'auth'), lit(null)), lit(true), lit(false))
      )).toBe('request.auth != null ? true : false');
    });
    test('in expression', () => {
      expect(assembleExpression(
        inExpr(str('admin'), list([str('admin'), str('user')]))
      )).toBe("'admin' in ['admin', 'user']");
    });
    test('is expression', () => {
      expect(assembleExpression(
        isExpr(m('request', 'resource', 'data', 'name'), 'string')
      )).toBe('request.resource.data.name is string');
    });
  });

  describe('1h: collections', () => {
    test('list with elements', () => {
      expect(assembleExpression(list([str('a'), str('b')]))).toBe("['a', 'b']");
    });
    test('empty list', () => {
      expect(assembleExpression(list([]))).toBe('[]');
    });
    test('map with entries', () => {
      expect(assembleExpression(
        map([{ key: str('key'), value: str('value') }])
      )).toBe("{'key': 'value'}");
    });
    test('empty map', () => {
      expect(assembleExpression(map([]))).toBe('{}');
    });
  });

  describe('1i: function calls and path literals', () => {
    test('no-arg function call', () => {
      expect(assembleExpression(fn('isAuthenticated'))).toBe('isAuthenticated()');
    });
    test('function call with path arg', () => {
      expect(assembleExpression(
        fn('exists', [path(['databases', id('database'), 'documents', 'users', id('uid')])])
      )).toBe('exists(/databases/$(database)/documents/users/$(uid))');
    });
    test('path literal', () => {
      expect(assembleExpression(
        path(['databases', id('database'), 'documents', 'users', id('uid')])
      )).toBe('/databases/$(database)/documents/users/$(uid)');
    });
    test('path with complex interpolation', () => {
      expect(assembleExpression(
        path(['databases', id('database'), 'documents', 'users', m('request', 'auth', 'uid')])
      )).toBe('/databases/$(database)/documents/users/$(request.auth.uid)');
    });
  });
});

// ---- Increment 2: Structural Nodes ----

describe('assembleRules', () => {
  describe('2a: minimal complete file', () => {
    test('deny-all rules', () => {
      const ast: FirestoreRules = {
        version: '2',
        imports: [],
        service: {
          name: 'cloud.firestore',
          match: {
            path: { raw: '/databases/{database}/documents', segments: [
              { type: 'literal', value: 'databases' },
              { type: 'wildcard', name: 'database' },
              { type: 'literal', value: 'documents' },
            ]},
            functions: [],
            allows: [],
            children: [{
              path: { raw: '/{doc=**}', segments: [{ type: 'recursive', name: 'doc' }] },
              functions: [],
              allows: [{ operations: ['read', 'write'], condition: lit(false) }],
              children: [],
            }],
          },
        },
      };
      const expected = [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /{doc=**} {',
        '      allow read, write: if false;',
        '    }',
        '  }',
        '}',
        '',
      ].join('\n');
      expect(assembleRules(ast)).toBe(expected);
    });
  });

  describe('2b: path assembly', () => {
    test('/users/{userId}', () => {
      const block: MatchBlock = {
        path: { raw: '/users/{userId}', segments: [
          { type: 'literal', value: 'users' },
          { type: 'wildcard', name: 'userId' },
        ]},
        functions: [], allows: [{ operations: ['read'], condition: lit(true) }], children: [],
      };
      expect(assembleMatchBlock(block, 4)).toContain('match /users/{userId} {');
    });
    test('/{document=**}', () => {
      const block: MatchBlock = {
        path: { raw: '/{document=**}', segments: [{ type: 'recursive', name: 'document' }] },
        functions: [], allows: [{ operations: ['read', 'write'], condition: lit(false) }], children: [],
      };
      expect(assembleMatchBlock(block, 4)).toContain('match /{document=**} {');
    });
    test('/users/{userId}/{sub=**}', () => {
      const block: MatchBlock = {
        path: { raw: '/users/{userId}/{sub=**}', segments: [
          { type: 'literal', value: 'users' },
          { type: 'wildcard', name: 'userId' },
          { type: 'recursive', name: 'sub' },
        ]},
        functions: [], allows: [], children: [],
      };
      expect(assembleMatchBlock(block, 4)).toContain('match /users/{userId}/{sub=**} {');
    });
  });

  describe('2c: allow rules', () => {
    test('single operation', () => {
      const block: MatchBlock = {
        path: { raw: '/x/{id}', segments: [{ type: 'literal', value: 'x' }, { type: 'wildcard', name: 'id' }] },
        functions: [], children: [],
        allows: [{ operations: ['read'], condition: lit(true) }],
      };
      expect(assembleMatchBlock(block, 0)).toContain('allow read: if true;');
    });
    test('multiple operations', () => {
      const block: MatchBlock = {
        path: { raw: '/x/{id}', segments: [{ type: 'literal', value: 'x' }, { type: 'wildcard', name: 'id' }] },
        functions: [], children: [],
        allows: [{ operations: ['read', 'write'], condition: lit(false) }],
      };
      expect(assembleMatchBlock(block, 0)).toContain('allow read, write: if false;');
    });
    test('granular operations', () => {
      const block: MatchBlock = {
        path: { raw: '/x/{id}', segments: [{ type: 'literal', value: 'x' }, { type: 'wildcard', name: 'id' }] },
        functions: [], children: [],
        allows: [{ operations: ['create', 'update'], condition: bin('!=', m('request', 'auth'), lit(null)) }],
      };
      expect(assembleMatchBlock(block, 0)).toContain('allow create, update: if request.auth != null;');
    });
  });

  describe('2d: functions', () => {
    test('zero-parameter function', () => {
      const block: MatchBlock = {
        path: { raw: '/x', segments: [{ type: 'literal', value: 'x' }] },
        allows: [], children: [],
        functions: [{
          name: 'isAuthenticated', parameters: [], exported: false, lets: [],
          body: bin('!=', m('request', 'auth'), lit(null)),
        }],
      };
      expect(assembleMatchBlock(block, 0)).toContain('function isAuthenticated() {');
      expect(assembleMatchBlock(block, 0)).toContain('return request.auth != null;');
    });
    test('function with parameter', () => {
      const block: MatchBlock = {
        path: { raw: '/x', segments: [{ type: 'literal', value: 'x' }] },
        allows: [], children: [],
        functions: [{
          name: 'isOwner', parameters: ['userId'], exported: false, lets: [],
          body: bin('&&', fn('isAuthenticated'), bin('==', m('request', 'auth', 'uid'), id('userId'))),
        }],
      };
      const out = assembleMatchBlock(block, 0);
      expect(out).toContain('function isOwner(userId) {');
      expect(out).toContain('return isAuthenticated() && request.auth.uid == userId;');
    });
    test('function with let bindings', () => {
      const block: MatchBlock = {
        path: { raw: '/x', segments: [{ type: 'literal', value: 'x' }] },
        allows: [], children: [],
        functions: [{
          name: 'checkAccess', parameters: ['uid'], exported: false,
          lets: [
            { name: 'user', value: fn('get', [path(['databases', id('database'), 'documents', 'users', id('uid')])]) },
            { name: 'role', value: m('user', 'data', 'role') },
          ],
          body: bin('==', id('role'), str('admin')),
        }],
      };
      const out = assembleMatchBlock(block, 0);
      expect(out).toContain('let user = get(/databases/$(database)/documents/users/$(uid));');
      expect(out).toContain('let role = user.data.role;');
      expect(out).toContain("return role == 'admin';");
    });
  });

  describe('2e: nested match blocks', () => {
    test('3-level nesting with correct indentation', () => {
      const ast: FirestoreRules = {
        version: '2',
        imports: [],
        service: {
          name: 'cloud.firestore',
          match: {
            path: { raw: '/databases/{database}/documents', segments: [
              { type: 'literal', value: 'databases' },
              { type: 'wildcard', name: 'database' },
              { type: 'literal', value: 'documents' },
            ]},
            functions: [], allows: [],
            children: [{
              path: { raw: '/teams/{teamId}', segments: [
                { type: 'literal', value: 'teams' },
                { type: 'wildcard', name: 'teamId' },
              ]},
              functions: [], allows: [{ operations: ['read'], condition: lit(true) }],
              children: [{
                path: { raw: '/members/{memberId}', segments: [
                  { type: 'literal', value: 'members' },
                  { type: 'wildcard', name: 'memberId' },
                ]},
                functions: [], allows: [{ operations: ['read'], condition: lit(true) }], children: [],
              }],
            }],
          },
        },
      };
      const out = assembleRules(ast);
      expect(out).toContain('    match /teams/{teamId} {');
      expect(out).toContain('      allow read: if true;');
      expect(out).toContain('      match /members/{memberId} {');
      expect(out).toContain('        allow read: if true;');
    });
    test('functions before allows before children', () => {
      const block: MatchBlock = {
        path: { raw: '/x/{id}', segments: [{ type: 'literal', value: 'x' }, { type: 'wildcard', name: 'id' }] },
        functions: [{ name: 'helper', parameters: [], exported: false, lets: [], body: lit(true) }],
        allows: [{ operations: ['read'], condition: fn('helper') }],
        children: [{
          path: { raw: '/y/{yid}', segments: [{ type: 'literal', value: 'y' }, { type: 'wildcard', name: 'yid' }] },
          functions: [], allows: [{ operations: ['read'], condition: lit(true) }], children: [],
        }],
      };
      const out = assembleMatchBlock(block, 0);
      const fnIdx = out.indexOf('function helper');
      const allowIdx = out.indexOf('allow read');
      const matchIdx = out.indexOf('match /y');
      expect(fnIdx).toBeLessThan(allowIdx);
      expect(allowIdx).toBeLessThan(matchIdx);
    });
  });

  describe('2f: edge cases', () => {
    test('empty match block', () => {
      const block: MatchBlock = {
        path: { raw: '/empty/{id}', segments: [{ type: 'literal', value: 'empty' }, { type: 'wildcard', name: 'id' }] },
        functions: [], allows: [], children: [],
      };
      const out = assembleMatchBlock(block, 0);
      expect(out).toContain('match /empty/{id} {');
      expect(out).toContain('}');
    });
    test('match with only functions', () => {
      const block: MatchBlock = {
        path: { raw: '/x/{id}', segments: [{ type: 'literal', value: 'x' }, { type: 'wildcard', name: 'id' }] },
        functions: [{ name: 'helper', parameters: [], exported: false, lets: [], body: lit(true) }],
        allows: [], children: [],
      };
      const out = assembleMatchBlock(block, 0);
      expect(out).toContain('function helper()');
      expect(out).not.toContain('allow');
    });
  });
});

// ---- Increment 3: Precedence Stress Tests ----

describe('precedence stress tests', () => {
  test('left-assoc && no parens', () => {
    expect(assembleExpression(bin('&&', bin('&&', id('a'), id('b')), id('c')))).toBe('a && b && c');
  });
  test('left-assoc || no parens', () => {
    expect(assembleExpression(bin('||', bin('||', id('a'), id('b')), id('c')))).toBe('a || b || c');
  });
  test('right child lower prec needs parens', () => {
    expect(assembleExpression(bin('&&', id('a'), bin('||', id('b'), id('c'))))).toBe('a && (b || c)');
  });
  test('mixed chain no parens needed', () => {
    // (a == b && c != d) || e > f  — all correct by precedence
    expect(assembleExpression(
      bin('||', bin('&&', bin('==', id('a'), id('b')), bin('!=', id('c'), id('d'))), bin('>', id('e'), id('f')))
    )).toBe('a == b && c != d || e > f');
  });
  test('!a && b', () => {
    expect(assembleExpression(bin('&&', unary('!', id('a')), id('b')))).toBe('!a && b');
  });
  test('!(a && b)', () => {
    expect(assembleExpression(unary('!', bin('&&', id('a'), id('b'))))).toBe('!(a && b)');
  });
  test('-a + b', () => {
    expect(assembleExpression(bin('+', unary('-', id('a')), id('b')))).toBe('-a + b');
  });
  test('(a ? b : c) && d', () => {
    expect(assembleExpression(bin('&&', ternary(id('a'), id('b'), id('c')), id('d')))).toBe('(a ? b : c) && d');
  });
  test('a is string && b is int', () => {
    expect(assembleExpression(
      bin('&&', isExpr(id('a'), 'string'), isExpr(id('b'), 'int'))
    )).toBe('a is string && b is int');
  });
  test('a + b * c - d / e', () => {
    expect(assembleExpression(
      bin('-', bin('+', id('a'), bin('*', id('b'), id('c'))), bin('/', id('d'), id('e')))
    )).toBe('a + b * c - d / e');
  });
  test('(a + b) * (c - d)', () => {
    expect(assembleExpression(
      bin('*', bin('+', id('a'), id('b')), bin('-', id('c'), id('d')))
    )).toBe('(a + b) * (c - d)');
  });
  test('double negation !!x', () => {
    expect(assembleExpression(unary('!', unary('!', id('x'))))).toBe('!!x');
  });
  test('method call on parenthesized expr', () => {
    expect(assembleExpression(
      method(bin('||', id('a'), id('b')), 'toString')
    )).toBe('(a || b).toString()');
  });
  test('right-assoc subtraction preserves parens', () => {
    expect(assembleExpression(bin('-', id('a'), bin('-', id('b'), id('c'))))).toBe('a - (b - c)');
  });
  test('right-assoc division preserves parens', () => {
    expect(assembleExpression(bin('/', id('a'), bin('/', id('b'), id('c'))))).toBe('a / (b / c)');
  });
  test('ternary in ternary condition needs parens', () => {
    expect(assembleExpression(
      ternary(ternary(id('a'), id('b'), id('c')), id('d'), id('e'))
    )).toBe('(a ? b : c) ? d : e');
  });
  test('ternary in ternary alternate no parens', () => {
    expect(assembleExpression(
      ternary(id('a'), id('b'), ternary(id('c'), id('d'), id('e')))
    )).toBe('a ? b : c ? d : e');
  });
  test('in binds tighter than &&', () => {
    expect(assembleExpression(
      bin('&&', inExpr(id('a'), id('b')), id('c'))
    )).toBe('a in b && c');
  });
  test('comparison binds tighter than equality', () => {
    expect(assembleExpression(
      bin('==', bin('>', id('a'), id('b')), id('c'))
    )).toBe('a > b == c');
  });
  test('complex nested: a && !(b || c) && d', () => {
    expect(assembleExpression(
      bin('&&', bin('&&', id('a'), unary('!', bin('||', id('b'), id('c')))), id('d'))
    )).toBe('a && !(b || c) && d');
  });
});
