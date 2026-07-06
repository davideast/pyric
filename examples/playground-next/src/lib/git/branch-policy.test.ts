import { describe, expect, test } from 'bun:test';

import {
  assertHeadNotBase,
  parseRepoFullName,
  validateFeatureBranch,
  validateRepoName,
} from './branch-policy';

describe('branch-policy', () => {
  test('parseRepoFullName accepts owner/name', () => {
    expect(parseRepoFullName('acme/firebase-app')).toEqual({
      owner: 'acme',
      name: 'firebase-app',
    });
  });

  test('parseRepoFullName rejects bad shapes', () => {
    expect(() => parseRepoFullName('not-a-repo')).toThrow(/owner\/name/);
    expect(() => parseRepoFullName('acme/')).toThrow();
  });

  test('validateFeatureBranch accepts feature names', () => {
    expect(() => validateFeatureBranch('feat/playground-rules')).not.toThrow();
    expect(() => validateFeatureBranch('fix-123')).not.toThrow();
  });

  test('validateFeatureBranch blocks protected and refspec-like names', () => {
    expect(() => validateFeatureBranch('main')).toThrow(/protected/);
    expect(() => validateFeatureBranch('master')).toThrow(/protected/);
    expect(() => validateFeatureBranch('refs/heads/x')).toThrow(/Invalid branch/);
    expect(() => validateFeatureBranch('feat:main')).toThrow(/Invalid branch/);
  });

  test('assertHeadNotBase rejects identical branches', () => {
    expect(() => assertHeadNotBase('main', 'main')).toThrow(/must differ/);
    expect(() => assertHeadNotBase('feat/x', 'main')).not.toThrow();
  });

  test('validateRepoName accepts GitHub-safe names', () => {
    expect(() => validateRepoName('firebase-app')).not.toThrow();
    expect(() => validateRepoName('my_playground.rules')).not.toThrow();
  });

  test('validateRepoName rejects invalid shapes', () => {
    expect(() => validateRepoName('')).toThrow(/required/);
    expect(() => validateRepoName('.hidden')).toThrow(/cannot start/);
    expect(() => validateRepoName('bad..name')).toThrow(/\.\./);
    expect(() => validateRepoName('spaces not allowed')).toThrow(/Invalid repo name/);
  });
});
