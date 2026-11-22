/**
 * Regression coverage for #1351 (FS2-CON-10): `firestoreRules().toJSON()`
 * returns a deep copy of the parsed AST so mutating the returned object cannot
 * alter subsequent `simulate()`, `explain()`, `lint()`, or `toJSON()` calls.
 */
import { describe, expect, test } from 'bun:test';
import { firestoreRules } from '../../src/index.js';
import type { MatchBlock } from '../../src/grammar/FirestoreAST.js';

function firstTopLevelMatch(ast: ReturnType<ReturnType<typeof firestoreRules>['toJSON']>): MatchBlock {
  const service = ast.service as { match?: MatchBlock; matches?: MatchBlock[] };
  if (Array.isArray(service.matches) && service.matches.length > 0) {
    return service.matches[0]!;
  }
  return service.match!;
}

describe('firestoreRules().toJSON() immutability (#1351)', () => {
  test('mutating allow conditions, operations, match children, or functions on toJSON() leaves simulate() and explain() unchanged', () => {
    const ruleset = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function alwaysFalse() {
      return false;
    }
    match /secrets/{id} {
      allow read: if false;
      allow write: if alwaysFalse();
    }
  }
}`);

    const ast = ruleset.toJSON();
    const rootMatch = firstTopLevelMatch(ast);
    const secretsMatch = rootMatch.children[0]!;
    const readAllow = secretsMatch.allows[0]!;
    (readAllow.condition as { value: boolean; raw: string }).value = true;
    (readAllow.condition as { value: boolean; raw: string }).raw = 'true';
    readAllow.operations.push('delete');
    secretsMatch.allows.push({
      operations: ['read', 'write'],
      condition: { type: 'literal', value: true, raw: 'true' },
    });
    rootMatch.functions = [
      {
        name: 'alwaysFalse',
        parameters: [],
        exported: false,
        lets: [],
        body: { type: 'literal', value: true, raw: 'true' },
      },
    ];

    const simulated = ruleset.simulate([
      {
        description: 'read stays denied after mutating toJSON()',
        expectation: 'DENY',
        method: 'get',
        path: 'secrets/s1',
        auth: { uid: 'alice' },
      },
      {
        description: 'write stays denied after mutating function body on toJSON()',
        expectation: 'DENY',
        method: 'create',
        path: 'secrets/s1',
        auth: { uid: 'alice' },
        data: { v: 1 },
      },
    ]);

    expect(simulated.passed).toBe(2);
    expect(simulated.failed).toBe(0);
    expect(simulated.cases.map((entry) => entry.decision)).toEqual(['DENY', 'DENY']);

    const explanation = ruleset.explain({
      description: 'explain stays denied',
      expectation: 'DENY',
      method: 'get',
      path: 'secrets/s1',
      auth: { uid: 'alice' },
    });
    expect(explanation.decision).toBe('DENY');

    const freshAst = ruleset.toJSON();
    const freshSecretsMatch = firstTopLevelMatch(freshAst).children[0]!;
    expect(freshSecretsMatch.allows).toHaveLength(2);
    expect((freshSecretsMatch.allows[0]!.condition as { value: boolean }).value).toBe(false);
  });
});
