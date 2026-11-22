import { describe, expect, test } from 'bun:test';
import { assembleRules } from '../../src/grammar/FirestoreAssembler.js';
import { parseToAST } from '../../src/grammar/FirestoreParser.js';
import { validateFirestoreRules } from '../../src/grammar/FirestoreValidator.js';
import { firestoreRules, lint, storageRules } from '../../src/index.js';
import { collectServiceRules } from '../../src/linter/ast-utils.js';
import { proveListQuery } from '../../src/simulator/list-query-proof.js';
import { evaluateStorageRules } from '../../src/storage/rules-evaluator.js';
import { parseStorageRules } from '../../src/storage/rules.js';

describe('#1348 multiple top-level match blocks per service in Firestore and Storage', () => {
  const c6FirestoreRules = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  function allowA() { return true; }',
    '  match /databases/{database}/documents {',
    '    match /a/{id} {',
    '      allow get, list: if allowA();',
    '    }',
    '  }',
    '  function allowB() { return request.auth != null; }',
    '  match /databases/{database}/documents {',
    '    match /b/{id} {',
    '      allow get, list: if allowB();',
    '    }',
    '  }',
    '  function unusedAfter() { return false; }',
    '}',
  ].join('\n');

  test('evaluates coordinator c6 multi-root Firestore ruleset as ALLOW, ALLOW, DENY in simulate() and proveListQuery', () => {
    const compiled = firestoreRules(c6FirestoreRules);
    const summary = compiled.simulate([
      { description: 'root 1 /a/1', expectation: 'ALLOW', method: 'get', path: 'a/1', auth: null },
      { description: 'root 2 /b/1', expectation: 'ALLOW', method: 'get', path: 'b/1', auth: { uid: 'u1' } },
      { description: 'unmatched /c/1', expectation: 'DENY', method: 'get', path: 'c/1', auth: { uid: 'u1' } },
    ]);
    expect(summary.cases.map((c) => c.decision)).toEqual(['ALLOW', 'ALLOW', 'DENY']);

    const listSummary = compiled.simulate([
      { description: 'list root 1 /a', expectation: 'ALLOW', method: 'list', path: 'a', auth: null },
      { description: 'list root 2 /b authed', expectation: 'ALLOW', method: 'list', path: 'b', auth: { uid: 'u1' } },
      { description: 'list root 2 /b anon', expectation: 'DENY', method: 'list', path: 'b', auth: null },
      { description: 'list unmatched /c', expectation: 'DENY', method: 'list', path: 'c', auth: { uid: 'u1' } },
    ]);
    expect(listSummary.cases.map((c) => c.decision)).toEqual(['ALLOW', 'ALLOW', 'DENY', 'DENY']);

    const ast = parseToAST(c6FirestoreRules)!;
    expect(ast.service.matches).toHaveLength(2);
    expect(proveListQuery(ast, 'a/__doc__', null, { filters: [] }).kind).toBe('provable');
    expect(proveListQuery(ast, 'c/__doc__', { uid: 'u1' }, { filters: [] }).kind).toBe('no-rule');
  });

  test('evaluates overlapping top-level roots with OR semantics across Firestore and Storage', () => {
    const overlappingFs = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} { allow get: if false; }',
      '  }',
      '  match /databases/(default)/documents/items/{id} {',
      '    allow get: if request.auth != null;',
      '  }',
      '}',
    ].join('\n');

    const fsSim = firestoreRules(overlappingFs).simulate([
      { description: 'anon denied by both roots', expectation: 'DENY', method: 'get', path: 'items/1', auth: null },
      { description: 'authed allowed by second root', expectation: 'ALLOW', method: 'get', path: 'items/1', auth: { uid: 'u1' } },
    ]);
    expect(fsSim.cases.map((c) => c.decision)).toEqual(['DENY', 'ALLOW']);

    const overlappingSt = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/bucket-a/o {',
      '    match /files/{id} { allow get: if false; }',
      '  }',
      '  match /b/{bucket}/o {',
      '    match /files/{id} { allow get: if bucket == "bucket-a" && request.auth != null; }',
      '  }',
      '}',
    ].join('\n');

    const parsedSt = parseStorageRules(overlappingSt);
    expect(
      evaluateStorageRules(parsedSt, {
        request: { auth: null, method: 'get', path: '/b/bucket-a/o/files/f1' },
        resource: { size: 1 },
      }).allowed,
    ).toBe(false);
    expect(
      evaluateStorageRules(parsedSt, {
        request: { auth: { uid: 'u1' }, method: 'get', path: '/b/bucket-a/o/files/f1' },
        resource: { size: 1 },
      }).allowed,
    ).toBe(true);
    expect(
      evaluateStorageRules(parsedSt, {
        request: { auth: { uid: 'u1' }, method: 'get', path: '/b/bucket-b/o/files/f1' },
        resource: { size: 1 },
      }).allowed,
    ).toBe(false);
  });

  test('preserves subpath prefixes in collectServiceRules, lint(), and validateFirestoreRules when a root has segments after /documents', () => {
    const subpathRoots = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents/tenants/{tenantId} {',
      '    match /orders/{orderId} {',
      '      allow read, write: if true;',
      '    }',
      '  }',
      '  match /databases/{database}/documents/audit/{entryId} {',
      '    allow get: if request.auth != null;',
      '  }',
      '}',
    ].join('\n');

    const ast = parseToAST(subpathRoots)!;
    const collected = collectServiceRules(ast.service);
    expect(collected.map((entry) => entry.path)).toEqual([
      '/tenants/{tenantId}/orders/{orderId}',
      '/databases/{database}/documents/audit/{entryId}',
    ]);

    const findings = validateFirestoreRules(ast);
    expect(findings.some((f) => f.code === 'SEC-1')).toBe(true);

    const lintIssues = lint(subpathRoots);
    expect(
      lintIssues.some(
        (i) => i.code === 'PERMISSIVE_RULE' && i.path === '/tenants/{tenantId}/orders/{orderId}',
      ),
    ).toBe(true);
  });

  test('round-trips multi-root Firestore and Storage rulesets through assembleRules() and leaves single-root AST shape unchanged', () => {
    const ast = parseToAST(c6FirestoreRules)!;
    const reprinted = assembleRules(ast);
    const reparsed = firestoreRules(reprinted).simulate([
      { description: 'reprint /a/1', expectation: 'ALLOW', method: 'get', path: 'a/1', auth: null },
      { description: 'reprint /b/1', expectation: 'ALLOW', method: 'get', path: 'b/1', auth: { uid: 'u1' } },
      { description: 'reprint /c/1', expectation: 'DENY', method: 'get', path: 'c/1', auth: { uid: 'u1' } },
    ]);
    expect(reparsed.cases.map((c) => c.decision)).toEqual(['ALLOW', 'ALLOW', 'DENY']);

    const singleRoot = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{database}/documents {',
      '    match /items/{id} { allow get: if request.auth != null; }',
      '  }',
      '}',
    ].join('\n');
    const singleAst = parseToAST(singleRoot)!;
    expect(singleAst.service.matches).toBeUndefined();
    expect(assembleRules(singleAst)).toContain('match /databases/{database}/documents {');

    const twoBucketSt = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/bucket-one/o {',
      '    match /{allPaths=**} { allow get: if true; }',
      '  }',
      '  match /b/{other}/o {',
      '    match /{allPaths=**} { allow get: if false; }',
      '  }',
      '}',
    ].join('\n');
    const stSim = storageRules(assembleRules(parseToAST(twoBucketSt)!), { bucket: 'bucket-one' }).simulate([
      { description: 'named bucket allowed', expectation: 'ALLOW', method: 'get', path: '/doc.txt', resource: { size: 1 } },
      {
        description: 'other bucket denied',
        expectation: 'DENY',
        method: 'get',
        bucket: 'bucket-two',
        path: '/doc.txt',
        resource: { size: 1 },
      },
    ]);
    expect(stSim.cases.map((c) => c.decision)).toEqual(['ALLOW', 'DENY']);
  });
});
