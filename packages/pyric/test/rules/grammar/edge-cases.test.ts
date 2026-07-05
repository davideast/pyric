/**
 * Expression and structure edge cases — converted from bug bash (72 assertions).
 * Tests whitespace variations, deep chaining, operator combinations, string
 * edge cases, comment placement, deeply nested match, and ambiguity probes.
 */
import { describe, test, expect } from 'bun:test';
import { parseExpression, parseRulesFile, parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';

function exprValid(input: string) { expect(parseExpression(input).valid).toBe(true); }
function exprInvalid(input: string) { expect(parseExpression(input).valid).toBe(false); }
function fileValid(input: string) { expect(parseRulesFile(input).valid).toBe(true); }
function fileInvalid(input: string) { expect(parseRulesFile(input).valid).toBe(false); }

const wrap = (body: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${body}
  }
}`;
const wrapExpr = (expr: string) => wrap(`match /t/{d} { allow read: if ${expr}; }`);

describe('Expression Edge Cases', () => {
  describe('whitespace variations', () => {
    test('no spaces around ==', () => exprValid('a==b'));
    test('lots of spaces', () => exprValid('a   ==   b'));
    test('newlines in expression', () => exprValid('a\n&&\nb'));
    test('tabs', () => exprValid('a\t&&\tb'));
  });

  describe('deep chaining', () => {
    test('5-level member chain', () => exprValid('a.b.c.d.e.f'));
    test('deep method chain', () => exprValid('a.b().c().d().e()'));
    test('method then member then method', () => exprValid('a.b().c.d()'));
  });

  describe('operator combinations', () => {
    test('all operators in one', () => exprValid('a + b * c - d / e % f > g && h || !i == j != k <= l >= m < n'));
    test('nested ternary', () => exprValid('a ? b ? c : d : e ? f : g'));
    test('in with method result', () => exprValid("request.resource.data.status in ['a', 'b'].concat(['c'])"));
    test('is with method result', () => exprValid('request.resource.data.get("x", null) is string'));
    test('negated in', () => exprValid("!('admin' in request.resource.data)"));
    test('negated is', () => exprValid('!(request.resource.data.x is string)'));
  });

  describe('string edge cases', () => {
    test('empty double-quoted', () => exprValid('""'));
    test('escaped double quote', () => exprValid('"hello\\"world"'));
    test('escaped newline', () => exprValid("'line1\\nline2'"));
    test('many escapes', () => exprValid("'a\\'b\\\\c\\nd'"));
  });

  describe('number edge cases', () => {
    test('zero', () => exprValid('0'));
    test('leading zeros', () => exprValid('007'));
    test('large number', () => exprValid('9999999999'));
  });

  describe('list/map edge cases', () => {
    test('nested list', () => exprValid('[[1, 2], [3, 4]]'));
    test('list with expressions', () => exprValid('[a + b, c * d, !e]'));
    test('map with expression values', () => exprValid('{key: a + b, other: !c}'));
    test('empty map', () => exprValid('{}'));
    test('single-entry map', () => exprValid('{a: 1}'));
    test('trailing comma in list', () => exprValid('[1, 2, 3,]'));
    test('trailing comma in map', () => exprValid('{a: 1, b: 2,}'));
  });

  describe('path edge cases', () => {
    test('multiple interpolations', () => exprValid('/databases/$(db)/documents/$(coll)/$(doc)'));
    test('expression in interpolation', () => exprValid('/databases/$(database)/documents/users/$(request.auth.uid)'));
    test('short path', () => exprValid('/a/b'));
  });

  describe('bracket access edge cases', () => {
    test('string concat key', () => exprValid("data[request.auth.uid + '_suffix']"));
    test('nested brackets', () => exprValid("data['a']['b']"));
    test('bracket then method', () => exprValid("data['key'].size()"));
  });

  describe('parenthesized expressions', () => {
    test('deeply nested parens', () => exprValid('((((a))))'));
    test('parens with operators', () => exprValid('(a + b) * (c - d)'));
    test('paren around ternary', () => exprValid('(a ? b : c) && d'));
  });

  describe('invalid expressions', () => {
    test('just a semicolon', () => exprInvalid(';'));
    test('assignment', () => exprInvalid('x = 5'));
    test('multiple expressions', () => exprInvalid('a; b'));
    test('unclosed method call', () => exprInvalid('a.b('));
    test('empty parens', () => exprInvalid('()'));
  });
});

describe('Structure Edge Cases', () => {
  describe('comments in unusual places', () => {
    test('comment before version', () => fileValid(`// comment
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{d} { allow read: if true; }
  }
}`));
    test('block comment in expression', () => fileValid(wrap('match /t/{d} { allow read: if /* comment */ true; }')));
  });

  describe('multiple and nested match blocks', () => {
    test('3 sibling matches', () => fileValid(wrap(`
      match /a/{id} { allow read: if true; }
      match /b/{id} { allow read: if true; }
      match /c/{id} { allow read: if true; }
    `)));

    test('4 levels deep', () => fileValid(wrap(`
      match /a/{aId} {
        allow read: if true;
        match /b/{bId} {
          allow read: if true;
          match /c/{cId} {
            allow read: if true;
            match /d/{dId} { allow read: if true; }
          }
        }
      }
    `)));
  });

  describe('path patterns', () => {
    test('path with dots', () => fileValid(wrap('match /com.example.app/{docId} { allow read: if true; }')));
    test('path with numbers', () => fileValid(wrap('match /v2/{docId} { allow read: if true; }')));
    test('path with hyphens', () => fileValid(wrap('match /my-collection/{docId} { allow read: if true; }')));
  });

  describe('function edge cases', () => {
    test('complex function body', () => fileValid(wrap(`
      function check() {
        return request.auth != null
               && request.auth.token.email_verified == true
               && request.resource.data.keys().hasAll(['a', 'b'])
               && request.resource.data.a is string;
      }
      match /t/{d} { allow read: if check(); }
    `)));

    test('function with multiple let bindings', () => fileValid(wrap(`
      function validate(data) {
        let keys = data.keys();
        let hasRequired = keys.hasAll(['title', 'body']);
        return hasRequired && data.title is string;
      }
      match /t/{d} { allow create: if validate(request.resource.data); }
    `)));
  });

  describe('real-world patterns', () => {
    test('rate limiting', () => fileValid(wrap(`
      match /posts/{postId} {
        allow create: if request.auth != null
                      && request.time > resource.data.lastWrite + duration.value(60, 's');
        allow read: if true;
      }
    `)));

    test('collection group query', () => fileValid(wrap(`
      match /{path=**}/reviews/{reviewId} {
        allow read: if true;
        allow create: if request.auth != null;
      }
    `)));

    test('getAfter for batched writes', () => fileValid(wrap(`
      match /accounts/{accountId} {
        allow update: if getAfter(/databases/$(database)/documents/accounts/$(accountId)).data.balance >= 0;
        allow read: if true;
      }
    `)));

    test('complex validation', () => fileValid(wrap(`
      function isValidPost(data) {
        return data.keys().hasAll(['title', 'body', 'author', 'createdAt'])
               && data.keys().hasOnly(['title', 'body', 'author', 'createdAt', 'tags', 'published'])
               && data.title is string
               && data.title.size() >= 1
               && data.title.size() <= 200
               && data.body is string
               && data.body.size() <= 50000
               && data.author is string
               && data.createdAt is timestamp
               && (data.tags == null || data.tags is list)
               && (data.published == null || data.published is bool);
      }
      match /posts/{postId} {
        allow create: if request.auth != null
                      && isValidPost(request.resource.data)
                      && request.resource.data.author == request.auth.uid
                      && request.resource.data.createdAt == request.time;
        allow read: if true;
      }
    `)));
  });

  describe('invalid files', () => {
    test('empty file', () => fileInvalid(''));
    test('just a comment', () => fileInvalid('// nothing'));
    test('missing service block', () => fileInvalid("rules_version = '2';"));
  });

  describe('ambiguity probes', () => {
    test('get as function in expression', () => fileValid(wrap(`
      match /t/{d} {
        allow read: if get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin';
      }
    `)));

    test('allow at documents level (valid Firestore)', () => fileValid(wrap('allow read: if true; match /t/{d} { allow write: if true; }')));
  });
});
