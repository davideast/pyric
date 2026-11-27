import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../src/grammar/FirestoreParser.js';
import { firestoreRules } from '../../src/index.js';
import { SimulateFirestoreRulesHandler } from '../../src/simulator/handler.js';
import { proveListQuery } from '../../src/simulator/list-query-proof.js';
import type { QueryWhereConstraint } from '../../src/simulator/query-proof.js';
import { RulesFloat } from '../../src/simulator/wrappers/float.js';
import type { ListQueryWhereConstraint } from '../../src/test/spec.js';

function rulesFor(condition: string): string {
  return `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if ${condition};
    }
  }
}`;
}

function listDecision(
  rulesSource: string,
  where: ListQueryWhereConstraint[],
  auth: { uid: string } | null = { uid: 'u1' },
): 'ALLOW' | 'DENY' {
  const result = firestoreRules(rulesSource).simulate([
    {
      description: 'list items',
      expectation: 'ALLOW',
      method: 'list',
      path: 'items',
      auth,
      query: { where },
    },
  ]);
  const decision = result.cases[0]?.decision;
  if (decision !== 'ALLOW' && decision !== 'DENY') {
    throw new Error(`unexpected decision: ${String(decision)}`);
  }
  return decision;
}

function internalListDecision(
  rulesSource: string,
  where: QueryWhereConstraint[],
): 'ALLOW' | 'DENY' {
  const ast = parseToAST(rulesSource);
  if (!ast) throw new Error('failed to parse rules');
  const proof = proveListQuery(ast, 'items/__listPlaceholder__', { uid: 'u1' }, { where }, rulesSource);
  if (proof.kind !== 'provable') return 'DENY';
  const sim = new SimulateFirestoreRulesHandler().simulateParsed(
    proof.evaluationAst,
    rulesSource,
    [
      {
        description: 'list items',
        expectation: 'ALLOW',
        method: 'list',
        path: 'items/__listPlaceholder__',
        auth: { uid: 'u1' },
        resource: proof.syntheticResource,
      },
    ],
    { skipQueryProof: true },
  );
  if (!sim.success) throw new Error(sim.error.message);
  const decision = sim.data.results[0]?.decision;
  if (decision !== 'ALLOW' && decision !== 'DENY') {
    throw new Error(`unexpected internal decision: ${String(decision)}`);
  }
  return decision;
}

describe('list query prover numeric int/float pin equivalence', () => {
  test('denies int-only and float-only guards for safe integer equality filters', () => {
    for (const value of [1, -5, 0, -0, 2 ** 53]) {
      const filters: ListQueryWhereConstraint[] = [{ field: 'score', op: '==', value }];
      expect(listDecision(rulesFor('resource.data.score is int'), filters)).toBe('DENY');
      expect(listDecision(rulesFor('resource.data.score is float'), filters)).toBe('DENY');
      expect(listDecision(rulesFor('!(resource.data.score is float)'), filters)).toBe('DENY');
    }
    for (const value of [1n, new RulesFloat(1), new RulesFloat(0)]) {
      const filters: QueryWhereConstraint[] = [{ field: 'score', op: '==', value }];
      expect(internalListDecision(rulesFor('resource.data.score is int'), filters)).toBe('DENY');
      expect(internalListDecision(rulesFor('resource.data.score is float'), filters)).toBe('DENY');
      expect(internalListDecision(rulesFor('resource.data.score is number'), filters)).toBe('ALLOW');
    }
  });

  test('keeps strict numeric wire typing for in filters and intersects cleanly with ==', () => {
    expect(listDecision(rulesFor('resource.data.score is int'), [{ field: 'score', op: 'in', value: [1] }])).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.score is float'), [{ field: 'score', op: 'in', value: [1] }])).toBe('DENY');
    expect(listDecision(rulesFor('resource.data.score is int'), [{ field: 'score', op: 'in', value: [0] }])).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.score is int'), [{ field: 'score', op: 'in', value: [-0] }])).toBe('DENY');
    expect(listDecision(rulesFor('resource.data.score is float'), [{ field: 'score', op: 'in', value: [-0] }])).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.score is int'), [{ field: 'score', op: 'in', value: [2 ** 53] }])).toBe('DENY');
    expect(
      listDecision(rulesFor('resource.data.score is int'), [
        { field: 'score', op: '==', value: 1 },
        { field: 'score', op: 'in', value: [1] },
      ]),
    ).toBe('ALLOW');
    expect(
      internalListDecision(rulesFor('resource.data.score is float'), [
        { field: 'score', op: '==', value: 1 },
        { field: 'score', op: 'in', value: [new RulesFloat(1)] },
      ]),
    ).toBe('ALLOW');
    expect(
      internalListDecision(rulesFor('resource.data.score is int'), [
        { field: 'score', op: 'in', value: [1, new RulesFloat(1)] },
      ]),
    ).toBe('DENY');
    expect(
      internalListDecision(rulesFor('resource.data.score is number'), [
        { field: 'score', op: 'in', value: [1, new RulesFloat(1)] },
      ]),
    ).toBe('ALLOW');
  });

  test('exercises +0.0 float variant alongside int 0 and -0.0 for zero equality filters', () => {
    const missesPositiveZero = "resource.data.score is int || string(resource.data.score) == '-0.0'";
    expect(listDecision(rulesFor(missesPositiveZero), [{ field: 'score', op: '==', value: 0 }])).toBe('DENY');
    expect(listDecision(rulesFor(missesPositiveZero), [{ field: 'score', op: '==', value: -0 }])).toBe('DENY');

    const coversAllZeroTypes = 'resource.data.score is int || resource.data.score is float';
    expect(listDecision(rulesFor(coversAllZeroTypes), [{ field: 'score', op: '==', value: 0 }])).toBe('ALLOW');
    expect(listDecision(rulesFor(coversAllZeroTypes), [{ field: 'score', op: '==', value: -0 }])).toBe('ALLOW');
    expect(
      listDecision(rulesFor('resource.data.score is int'), [
        { field: 'score', op: '==', value: 0 },
        { field: 'score', op: '==', value: -0 },
      ]),
    ).toBe('DENY');
  });

  test('denies type-sensitive numeric arithmetic, string conversion, and list membership under ==', () => {
    const eqOne: ListQueryWhereConstraint[] = [{ field: 'score', op: '==', value: 1 }];
    expect(listDecision(rulesFor('resource.data.score / 2 == 0'), eqOne)).toBe('DENY');
    expect(listDecision(rulesFor("string(resource.data.score) == '1'"), eqOne)).toBe('DENY');
    expect(listDecision(rulesFor('resource.data.score in [1]'), eqOne)).toBe('DENY');
    expect(listDecision(rulesFor('resource.data.score in [1.0]'), eqOne)).toBe('DENY');
    expect(listDecision(rulesFor('resource.data.score in [1, 1.0]'), eqOne)).toBe('ALLOW');

    const inOne: ListQueryWhereConstraint[] = [{ field: 'score', op: 'in', value: [1] }];
    expect(listDecision(rulesFor('resource.data.score in [1]'), inOne)).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.score in [1.0]'), inOne)).toBe('DENY');

    const eqZero: ListQueryWhereConstraint[] = [{ field: 'score', op: '==', value: 0 }];
    expect(listDecision(rulesFor('resource.data.score in [0]'), eqZero)).toBe('DENY');
    expect(listDecision(rulesFor('resource.data.score in [0, 0.0]'), eqZero)).toBe('ALLOW');
  });

  test('allows value-equivalent comparisons and non-integer float type guards', () => {
    const eqOne: ListQueryWhereConstraint[] = [{ field: 'score', op: '==', value: 1 }];
    expect(listDecision(rulesFor('resource.data.score == 1'), eqOne)).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.score == 1.0'), eqOne)).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.score is number'), eqOne)).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.score is int || resource.data.score is float'), eqOne)).toBe('ALLOW');

    const eqFraction: ListQueryWhereConstraint[] = [{ field: 'score', op: '==', value: 1.5 }];
    expect(listDecision(rulesFor('resource.data.score is float'), eqFraction)).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.score is int'), eqFraction)).toBe('DENY');
  });

  test('preserves strict int vs float typing for array-contains list membership', () => {
    const containsOne: ListQueryWhereConstraint[] = [{ field: 'scores', op: 'array-contains', value: 1 }];
    expect(listDecision(rulesFor('1 in resource.data.scores'), containsOne)).toBe('ALLOW');
    expect(listDecision(rulesFor('1.0 in resource.data.scores'), containsOne)).toBe('DENY');
    expect(listDecision(rulesFor('resource.data.scores.hasAny([1])'), containsOne)).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.scores.hasAny([1.0])'), containsOne)).toBe('DENY');

    const containsFloatOne: QueryWhereConstraint[] = [
      { field: 'scores', op: 'array-contains', value: new RulesFloat(1) },
    ];
    expect(internalListDecision(rulesFor('1.0 in resource.data.scores'), containsFloatOne)).toBe('ALLOW');
    expect(internalListDecision(rulesFor('1 in resource.data.scores'), containsFloatOne)).toBe('DENY');

    const containsNegZero: ListQueryWhereConstraint[] = [{ field: 'scores', op: 'array-contains', value: -0 }];
    expect(listDecision(rulesFor('0.0 in resource.data.scores'), containsNegZero)).toBe('ALLOW');
    expect(listDecision(rulesFor('0 in resource.data.scores'), containsNegZero)).toBe('DENY');

    const containsFraction: ListQueryWhereConstraint[] = [{ field: 'scores', op: 'array-contains', value: 1.5 }];
    expect(listDecision(rulesFor('1.5 in resource.data.scores'), containsFraction)).toBe('ALLOW');
    expect(listDecision(rulesFor('resource.data.scores.hasAll([1.5])'), containsFraction)).toBe('ALLOW');
  });

  test('array-contains-any proves membership only when every alternative guarantees that element', () => {
    const source = rulesFor('1 in resource.data.scores');
    const decide = (values: QueryWhereConstraint['value']) => internalListDecision(source, [
      { field: 'scores', op: 'array-contains-any', value: values },
    ]);
    expect(decide([1])).toBe('ALLOW');
    expect(decide([1, 1])).toBe('ALLOW');
    expect(decide([1, new RulesFloat(1)])).toBe('DENY');
    expect(decide([2, 1])).toBe('DENY');
    expect(decide([])).toBe('DENY');
    expect(decide(1)).toBe('DENY');
  });

  test('preserves worst-case lookup budget when an unprovable sibling guards lookups with a numeric type check', () => {
    const lookups = Array.from(
      { length: 11 },
      (_, idx) => `exists(/databases/$(database)/documents/flags/f${idx})`,
    ).join(' || ');
    const source = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if resource.data.other == 'x' && (resource.data.score is float && (${lookups}));
      allow list: if resource.data.score == 1 && request.auth != null;
    }
  }
}`;
    expect(listDecision(source, [{ field: 'score', op: '==', value: 1 }])).toBe('DENY');
  });
});
