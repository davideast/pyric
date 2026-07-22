import { describe, expect, test } from 'bun:test';
import {
  RequestBudget,
  runCleanupSteps,
} from '../../src/storage-stdlib-real-budget.ts';

describe('storage stdlib real request safety', () => {
  test('request budgets fail before exceeding a paid-operation cap', () => {
    const budget = new RequestBudget({ storage: 2, firestoreWrite: 1, rules: 1, iam: 1 });
    budget.take('storage', 2);
    expect(() => budget.take('storage')).toThrow('storage request budget exceeded: 3 > 2');
    expect(budget.snapshot().counts.storage).toBe(2);
  });

  test('cleanup continues after a restoration step fails', async () => {
    const visited: string[] = [];
    await expect(runCleanupSteps([
      { label: 'rules', run: async () => { visited.push('rules'); throw new Error('release failed'); } },
      { label: 'objects', run: async () => { visited.push('objects'); } },
      { label: 'documents', run: async () => { visited.push('documents'); } },
      { label: 'app', run: async () => { visited.push('app'); } },
    ])).rejects.toThrow('real-resource cleanup failed');
    expect(visited).toEqual(['rules', 'objects', 'documents', 'app']);
  });
});
