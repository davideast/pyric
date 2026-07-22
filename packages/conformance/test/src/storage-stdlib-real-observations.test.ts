import { describe, expect, test } from 'bun:test';
import { RequestBudget } from '../../src/storage-stdlib-real-budget.ts';
import { storageObservation } from '../../src/storage-stdlib-real-observations.ts';

describe('storage stdlib real observation support', () => {
  test('records request budgets and explicit behavior without claiming a row', () => {
    const budget = new RequestBudget({ storage: 1, firestoreWrite: 1, rules: 1, iam: 1 });
    budget.take('storage');
    const observation = storageObservation(
      'probe',
      'description',
      'project',
      'bucket',
      { allowed: true },
      {},
      { objects: true },
      budget,
    );
    expect(observation.matrixRow).toBe('');
    expect(observation.behavior).toEqual({ allowed: true });
    expect(observation.requestBudget).toEqual(budget.snapshot());
  });
});
