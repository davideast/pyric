import { describe, expect, test } from 'bun:test';
import { canonicalPolicy } from '../../src/storage-stdlib-real-iam.ts';

describe('storage stdlib real IAM support', () => {
  test('canonicalizes binding and member order without mutating input', () => {
    const policy = { bindings: [
      { role: 'roles/z', members: ['user:b', 'user:a'] },
      { role: 'roles/a', members: ['user:c'] },
    ] };
    const canonical = JSON.parse(canonicalPolicy(policy)) as {
      bindings: Array<{ role: string; members: string[] }>;
    };
    expect(canonical.bindings.map(({ role }) => role)).toEqual(['roles/a', 'roles/z']);
    expect(canonical.bindings[1]?.members).toEqual(['user:a', 'user:b']);
    expect(policy.bindings[0]?.members).toEqual(['user:b', 'user:a']);
  });
});
