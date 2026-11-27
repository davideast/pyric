// Unit and Storage-simulator parity tests for packages/rules/src/policy/storage.ts.
import { describe, expect, test } from 'bun:test';
import { firestoreGrammar, firestoreSemantics } from '../../src/grammar/FirestoreParser.js';
import type { Expression } from '../../src/grammar/FirestoreAST.js';
import { evaluate } from '../../src/simulator/evaluator.js';
import { storageRules, type StorageCase } from '../../src/api/storage.js';
import {
  compileStorageProjections,
  composeStorage,
  emitStorageModule,
  lowerStorage,
  type StorageBindings,
} from '../../src/policy/storage.js';

const BUCKET = 'demo-app.appspot.com';

function parseExpr(source: string): Expression {
  const match = firestoreGrammar.match(source, 'Expr');
  if (match.failed()) throw new Error(match.message);
  return firestoreSemantics(match).toAST() as Expression;
}

function evalInterpreter(expr: Expression, scope: Record<string, unknown>): 'ALLOW' | 'DENY' {
  try {
    return evaluate(expr, {}, scope) === true ? 'ALLOW' : 'DENY';
  } catch {
    return 'DENY';
  }
}

describe('Firebase Storage Rules v2 target (policy/storage.ts)', () => {
  test('lowers voice-clip upload policy and matches storageRules().simulate()', () => {
    const expr = parseExpr(
      'input.auth != null && after.size < 2 * 1024 * 1024 && after.contentType == "audio/wav"',
    );
    const bindings: StorageBindings = {
      'input.auth': 'request.auth',
      after: 'request.resource',
    };
    const lowered = lowerStorage(expr, compileStorageProjections(bindings));
    expect(lowered.problems).toEqual([]);
    expect(lowered.predicate).toContain('request.resource.size');
    expect(lowered.predicate).toContain('request.resource.contentType');

    const ruleset = storageRules([
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /clips/{clip} {',
      `      allow create: if ${lowered.predicate};`,
      '    }',
      '  }',
      '}',
    ].join('\n'), { bucket: BUCKET });

    const testCases: Array<{
      id: string;
      auth: { uid: string } | null;
      reqRes: { size: number; contentType: string };
    }> = [
      { id: 'valid', auth: { uid: 'u1' }, reqRes: { size: 256, contentType: 'audio/wav' } },
      { id: 'anon', auth: null, reqRes: { size: 256, contentType: 'audio/wav' } },
      { id: 'wrong-mime', auth: { uid: 'u1' }, reqRes: { size: 256, contentType: 'audio/mpeg' } },
      { id: 'at-limit', auth: { uid: 'u1' }, reqRes: { size: 2 * 1024 * 1024, contentType: 'audio/wav' } },
      { id: 'below-limit', auth: { uid: 'u1' }, reqRes: { size: 2 * 1024 * 1024 - 1, contentType: 'audio/wav' } },
    ];
    for (const tc of testCases) {
      const expected = evalInterpreter(expr, { input: { auth: tc.auth }, after: tc.reqRes });
      const [row] = ruleset.simulate([{
        description: tc.id,
        expectation: expected,
        method: 'create',
        path: 'clips/a.wav',
        auth: tc.auth,
        requestResource: tc.reqRes,
      }]).cases;
      expect(row?.unsupported).toBe(false);
      expect(row?.decision, tc.id).toBe(expected);
    }
  });

  test('supports RE2 matches, metadata.get, in-list, and before/after update invariants', () => {
    const createExpr = parseExpr(
      'input.uid == input.owner && after.size <= 1048576'
      + ' && after.contentType.matches("image/(png|jpeg)")'
      + ' && after.contentType in ["image/png", "image/jpeg"]'
      + ' && after.metadata.get("owner", "") == input.uid',
    );
    const createBindings: StorageBindings = {
      'input.uid': 'request.auth.uid',
      'input.owner': 'uid',
      after: 'request.resource',
    };
    const createLowered = lowerStorage(createExpr, compileStorageProjections(createBindings));
    expect(createLowered.problems).toEqual([]);

    const updateExpr = parseExpr(
      'input.uid == before.metadata.owner && after.metadata.owner == before.metadata.owner'
      + ' && after.size <= before.size',
    );
    const updateBindings: StorageBindings = {
      'input.uid': 'request.auth.uid',
      before: 'resource',
      after: 'request.resource',
    };
    const updateLowered = lowerStorage(updateExpr, compileStorageProjections(updateBindings));
    expect(updateLowered.problems).toEqual([]);

    const ruleset = storageRules([
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    match /avatars/{uid}/{file} {',
      `      allow create: if ${createLowered.predicate};`,
      `      allow update: if ${updateLowered.predicate};`,
      '    }',
      '  }',
      '}',
    ].join('\n'), { bucket: BUCKET });

    const cases: StorageCase[] = [
      {
        description: 'valid png avatar create',
        expectation: 'ALLOW',
        method: 'create',
        path: 'avatars/alice/me.png',
        auth: { uid: 'alice' },
        requestResource: { size: 4096, contentType: 'image/png', metadata: { owner: 'alice' } },
      },
      {
        description: 'wrong owner metadata denied',
        expectation: 'DENY',
        method: 'create',
        path: 'avatars/alice/me.png',
        auth: { uid: 'alice' },
        requestResource: { size: 4096, contentType: 'image/png', metadata: { owner: 'bob' } },
      },
      {
        description: 'svg mime rejected by matches',
        expectation: 'DENY',
        method: 'create',
        path: 'avatars/alice/me.svg',
        auth: { uid: 'alice' },
        requestResource: { size: 4096, contentType: 'image/svg+xml', metadata: { owner: 'alice' } },
      },
      {
        description: 'valid metadata update keeping owner and size',
        expectation: 'ALLOW',
        method: 'update',
        path: 'avatars/alice/me.png',
        auth: { uid: 'alice' },
        resource: { size: 4096, contentType: 'image/png', metadata: { owner: 'alice' } },
        requestResource: { size: 4096, contentType: 'image/png', metadata: { owner: 'alice' } },
      },
      {
        description: 'update attempting owner transfer denied',
        expectation: 'DENY',
        method: 'update',
        path: 'avatars/alice/me.png',
        auth: { uid: 'alice' },
        resource: { size: 4096, contentType: 'image/png', metadata: { owner: 'alice' } },
        requestResource: { size: 4096, contentType: 'image/png', metadata: { owner: 'mallory' } },
      },
    ];
    const summary = ruleset.simulate(cases);
    expect(summary.unsupported).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.passed).toBe(cases.length);
  });

  test('rejects invalid Storage projections, wrong origins, invalid RE2 regex, and Firestore-only fields', () => {
    const expr = parseExpr('after.size < 100');
    // Firestore-only resource.data is rejected
    expect(lowerStorage(expr, compileStorageProjections({ after: 'request.resource.data' })).predicate).toBeUndefined();
    // Timing mismatch: after bound to resource
    expect(lowerStorage(expr, compileStorageProjections({ 'after.size': 'resource.size' })).problems[0]).toContain('requires after');
    // Unknown field on request.resource
    expect(lowerStorage(parseExpr('after.bogus == 1'), compileStorageProjections({ after: 'request.resource' })).predicate).toBeUndefined();
    // Invalid RE2 regex rejected by parseStorageRules
    const badRegex = lowerStorage(
      parseExpr('after.contentType.matches("[unterminated")'),
      compileStorageProjections({ after: 'request.resource' }),
    );
    expect(badRegex.predicate).toBeUndefined();
    expect(badRegex.problems.length).toBeGreaterThan(0);

    // Storage absent-error roots (request.auth, resource, request.resource) raise RuleError, not null
    const rootProj = compileStorageProjections({
      'input.auth': 'request.auth',
      before: 'resource',
      after: 'request.resource',
    });
    for (const bad of [
      'input.auth == null',
      'null == input.auth',
      '!(input.auth != null)',
      '!(null != input.auth)',
      'before == null',
      'after == null',
    ]) {
      const r = lowerStorage(parseExpr(bad), rootProj);
      expect(r.predicate, bad).toBeUndefined();
      expect(r.problems[0], bad).toContain('diverges');
    }
  });

  test('emitStorageModule and composeStorage enforce conjunctive slots and verb exclusivity', () => {
    const expr = parseExpr('after.size < 1024 && after.contentType == "text/plain"');
    const lower = (bindings: StorageBindings) => {
      const r = lowerStorage(expr, compileStorageProjections(bindings));
      return [{ requirement: 'plainSmall', reason: r.problems.join('; ') || 'ok', predicate: r.predicate, origins: r.origins }];
    };

    const mod = emitStorageModule('validUpload', lower({ after: 'request.resource' }));
    expect(mod).toContain("rules_version = '2+modules';");
    expect(mod).toContain('export function validUpload()');

    const template = [
      "rules_version = '2';",
      'service firebase.storage {',
      '  match /b/{bucket}/o {',
      '    function policySlot() { return false; }',
      '    match /notes/{file} {',
      '      allow create: if request.auth != null && policySlot();',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const composed = composeStorage(
      {
        rules: template,
        slot: 'policySlot',
        placements: [{ path: '/b/{bucket}/o/notes/{file}', operation: 'create', bindings: { after: 'request.resource' } }],
      },
      ['plainSmall'],
      lower,
    );
    const ruleset = storageRules(composed.rules, { bucket: BUCKET });
    expect(ruleset.simulate([
      { description: 'ok', expectation: 'ALLOW', method: 'create', path: 'notes/a.txt', auth: { uid: 'u1' }, requestResource: { size: 100, contentType: 'text/plain' } },
      { description: 'too large', expectation: 'DENY', method: 'create', path: 'notes/a.txt', auth: { uid: 'u1' }, requestResource: { size: 2048, contentType: 'text/plain' } },
    ]).passed).toBe(2);

    // Reject overlapping sibling `allow write` that would bypass `allow create`
    const bypassTemplate = template.replace(
      'allow create: if request.auth != null && policySlot();',
      'allow create: if request.auth != null && policySlot();\n      allow write: if true;',
    );
    expect(() => composeStorage(
      {
        rules: bypassTemplate,
        slot: 'policySlot',
        placements: [{ path: '/b/{bucket}/o/notes/{file}', operation: 'create', bindings: { after: 'request.resource' } }],
      },
      ['plainSmall'],
      lower,
    )).toThrow(/Another allow covers/);

    // Reject disjunction bypass `true || policySlot()`
    const orTemplate = template.replace('request.auth != null && policySlot()', 'true || policySlot()');
    expect(() => composeStorage(
      {
        rules: orTemplate,
        slot: 'policySlot',
        placements: [{ path: '/b/{bucket}/o/notes/{file}', operation: 'create', bindings: { after: 'request.resource' } }],
      },
      ['plainSmall'],
      lower,
    )).toThrow(/required conjunct/);

    // Reject binding request.resource on delete
    const deleteTemplate = template.replace('allow create:', 'allow delete:');
    expect(() => composeStorage(
      {
        rules: deleteTemplate,
        slot: 'policySlot',
        placements: [{ path: '/b/{bucket}/o/notes/{file}', operation: 'delete', bindings: { after: 'request.resource' } }],
      },
      ['plainSmall'],
      lower,
    )).toThrow(/request\.resource is unset/);
  });
});
