import { describe, expect, test } from 'bun:test';
import {
  RequestBudget,
  firestoreDocumentName,
  injectIntoMatch,
  resolveCredentialPath,
  rulesLiteral,
  runCleanupSteps,
} from './storage-stdlib-real-support.ts';
import { acquireRunLock } from './run-storage-stdlib-real.ts';

describe('storage stdlib real-resource support', () => {
  test('credential paths resolve from the invoking working directory', () => {
    expect(resolveCredentialPath('credentials/oracle.json', '/worktree'))
      .toBe('/worktree/credentials/oracle.json');
    expect(resolveCredentialPath('/secrets/oracle.json', '/worktree'))
      .toBe('/secrets/oracle.json');
  });

  test('request budgets fail before exceeding a paid-operation cap', () => {
    const budget = new RequestBudget({ storage: 2, firestoreWrite: 1, rules: 1, iam: 1 });
    budget.take('storage', 2);
    expect(() => budget.take('storage')).toThrow('storage request budget exceeded: 3 > 2');
    expect(budget.snapshot().counts.storage).toBe(2);
  });

  test('Rules literals escape quotes, slashes, and Unicode without interpolation', () => {
    expect(rulesLiteral('a"b\\c雪')).toBe('"a\\"b\\\\c雪"');
  });

  test('source injection fails closed when the canonical match is absent', () => {
    const pattern = /(match\s+\/b\/\{bucket\}\/o\s*\{)/;
    expect(injectIntoMatch('service firebase.storage { match /b/{bucket}/o { } }', pattern, '`match /b/{bucket}/o`', '\nprobe\n'))
      .toContain('probe');
    expect(() => injectIntoMatch('service firebase.storage {}', pattern, '`match /b/{bucket}/o`', '\nprobe\n'))
      .toThrow('current rules lack canonical');
  });

  test('cleanup targets preserve project and database identity', () => {
    expect(firestoreDocumentName('p', '(default)', 'r1', 'a'))
      .toBe('projects/p/databases/(default)/documents/__pyric_storage_stdlib/r1/docs/a');
    expect(firestoreDocumentName('p', 'probes', 'r1', 'a'))
      .toBe('projects/p/databases/probes/documents/__pyric_storage_stdlib/r1/docs/a');
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

  test('exclusive lock rejects an overlapping real-resource run', () => {
    const path = `/tmp/pyric-storage-stdlib-real-test-${process.pid}.lock`;
    const release = acquireRunLock(path);
    try {
      expect(() => acquireRunLock(path)).toThrow('another storage-stdlib real-resource probe is already running');
    } finally {
      release();
    }
  });
});
