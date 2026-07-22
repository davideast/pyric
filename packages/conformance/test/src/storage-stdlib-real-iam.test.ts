import { describe, expect, test } from 'bun:test';
import {
  canonicalPolicy,
  restoreIamPolicy,
  type IamPolicy,
} from '../../src/storage-stdlib-real-iam.ts';

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

  for (const failure of ['get', 'set'] as const) {
    test(`retries IAM restoration after a first-attempt ${failure} failure`, async () => {
      const original: IamPolicy = { etag: 'old', bindings: [] };
      const granted: IamPolicy = {
        etag: 'granted',
        bindings: [{ role: 'roles/test', members: ['serviceAccount:probe'] }],
      };
      let current = granted;
      let failed = false;
      let requests = 0;
      const restored = await restoreIamPolicy(
        'https://example.test:getIamPolicy',
        original,
        { auth: {}, json: {} },
        async (_url, init) => {
          requests += 1;
          const body = JSON.parse(String(init.body)) as { policy?: IamPolicy };
          const isSet = body.policy !== undefined;
          if (!failed && ((failure === 'get' && !isSet) || (failure === 'set' && isSet))) {
            failed = true;
            throw new Error(`transient ${failure}`);
          }
          if (isSet) current = { ...body.policy, etag: 'restored' };
          return current;
        },
        async () => {},
      );
      expect(restored).toBe(true);
      expect(failed).toBe(true);
      expect(requests).toBeGreaterThanOrEqual(4);
    });
  }
});
