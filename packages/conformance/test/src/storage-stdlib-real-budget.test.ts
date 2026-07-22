import { describe, expect, test } from 'bun:test';
import {
  RequestBudget,
  STORAGE_CLEANUP_LIMITS,
  runCleanupSteps,
  storageProbeRequestKind,
} from '../../src/storage-stdlib-real-budget.ts';

describe('storage stdlib real request safety', () => {
  test('request budgets fail before exceeding a paid-operation cap', () => {
    const budget = new RequestBudget({ storage: 2, firestoreWrite: 1, rules: 1, iam: 1 });
    budget.take('storage', 2);
    expect(() => budget.take('storage')).toThrow('storage request budget exceeded: 3 > 2');
    expect(budget.snapshot().counts.storage).toBe(2);
  });

  test('reserves enough requests for worst-case native object cleanup', () => {
    const cleanup = new RequestBudget({ ...STORAGE_CLEANUP_LIMITS });
    cleanup.take('storage', 32);
    cleanup.take('rules', 4);
    expect(cleanup.snapshot().counts).toEqual({
      storage: 32,
      firestoreWrite: 0,
      rules: 4,
      iam: 0,
    });
  });

  test('reserves and classifies every cross-service cleanup request', () => {
    const cleanup = new RequestBudget({ ...STORAGE_CLEANUP_LIMITS });
    cleanup.take('firestoreWrite', 24);
    cleanup.take('rules', 8);
    cleanup.take('iam', 6);
    expect(cleanup.snapshot().counts).toEqual({
      storage: 0, firestoreWrite: 24, rules: 8, iam: 6,
    });
    expect(storageProbeRequestKind('https://storage.googleapis.com/storage/v1/b/x')).toBe('storage');
    expect(storageProbeRequestKind('https://firestore.googleapis.com/v1/projects/x')).toBe('firestoreWrite');
    expect(storageProbeRequestKind('https://cloudresourcemanager.googleapis.com/v1/projects/x')).toBe('iam');
    expect(storageProbeRequestKind('https://firebaserules.googleapis.com/v1/projects/x')).toBe('rules');
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
