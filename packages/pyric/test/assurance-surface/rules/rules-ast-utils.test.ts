import { describe, expect, test } from 'bun:test';
import {
  expandRuleOps,
  isOverbroadAuthOnlyRulesExpr,
  parseRulesAstWithMultiMatch,
} from '../../../src/assurance-surface/rules/rules-ast-utils.js';

describe('rules-ast-utils', () => {
  test('parses standard single-match rules and multi-match service blocks while preserving line numbers', () => {
    const multiMatchStorage = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  function isSignedIn() { return request.auth != null; }',
      '  match /b/media-prod/o {',
      '    match /avatars/{uid} {',
      '      allow read, write: if isSignedIn() && request.auth.uid == uid;',
      '    }',
      '  }',
      '  match /b/exports-prod/o {',
      '    match /reports/{reportId} {',
      '      allow get: if isSignedIn();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const services = parseRulesAstWithMultiMatch(multiMatchStorage);
    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe('firebase.storage');
    expect(services[0]!.matches).toHaveLength(2);
    const firstAllow = services[0]!.matches[0]!.children[0]!.allows[0]!;
    const secondAllow = services[0]!.matches[1]!.children[0]!.allows[0]!;
    expect(firstAllow.loc?.line).toBe(6);
    expect(secondAllow.loc?.line).toBe(11);
  });

  test('normalizes literal (default) Firestore match headers without shifting line numbers', () => {
    const multiDbFirestore = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/(default)/documents {',
      '    match /users/{uid} {',
      '      allow read: if request.auth != null;',
      '    }',
      '  }',
      '  match /databases/analytics/documents {',
      '    match /events/{eventId} {',
      '      allow create: if request.auth != null;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const services = parseRulesAstWithMultiMatch(multiDbFirestore);
    expect(services).toHaveLength(1);
    expect(services[0]!.matches).toHaveLength(2);
    expect(
      services[0]!.matches[0]!.path.segments.map((s) => {
        if (s.type === 'literal') return s.value;
        return s.name;
      }),
    ).toEqual([
      'databases',
      '(default)',
      'documents',
    ]);
    expect(services[0]!.matches[1]!.children[0]!.allows[0]!.loc?.line).toBe(10);
  });

  test('expands coarse read and write rule verbs into granular operations', () => {
    expect(expandRuleOps(['read'])).toEqual(['get', 'list']);
    expect(expandRuleOps(['write'])).toEqual(['create', 'update', 'delete']);
    expect(expandRuleOps(['get', 'create'])).toEqual(['get', 'create']);
  });

  test('detects overbroad auth-only rule conditions including inlined helper functions', () => {
    const source = `
      rules_version = '2';
      service cloud.firestore {
        function isSignedIn() {
          let authed = request.auth != null;
          return authed && request.auth.uid != null;
        }
        function isAdmin() {
          return request.auth != null && request.auth.token.role == 'admin';
        }
        match /databases/{database}/documents {
          match /items/{itemId} {
            allow create: if request.auth != null;
            allow update: if isSignedIn();
            allow delete: if isAdmin();
          }
          match /users/{uid} {
            allow write: if isSignedIn() && request.auth.uid == uid;
          }
        }
      }
    `;
    const [svc] = parseRulesAstWithMultiMatch(source);
    const itemsBlock = svc!.matches[0]!.children[0]!;
    const usersBlock = svc!.matches[0]!.children[1]!;
    const baseScope = {
      vars: new Map(),
      functions: [...svc!.functions, itemsBlock.functions],
      wildcards: new Set(['database', 'itemId']),
      depth: 0,
    };
    expect(isOverbroadAuthOnlyRulesExpr(itemsBlock.allows[0]!.condition, baseScope)).toBe(true);
    expect(isOverbroadAuthOnlyRulesExpr(itemsBlock.allows[1]!.condition, baseScope)).toBe(true);
    expect(isOverbroadAuthOnlyRulesExpr(itemsBlock.allows[2]!.condition, baseScope)).toBe(false);

    const userScope = {
      vars: new Map(),
      functions: [...svc!.functions, usersBlock.functions],
      wildcards: new Set(['database', 'uid']),
      depth: 0,
    };
    expect(isOverbroadAuthOnlyRulesExpr(usersBlock.allows[0]!.condition, userScope)).toBe(false);
  });
});
