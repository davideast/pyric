import { describe, expect, test } from 'bun:test';
import {
  canonicalPolicy,
  restoreIamPolicy,
  withTemporaryFirestoreRulesIam,
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

  test('owns the grant, work, and restore lifecycle', async () => {
    const original: IamPolicy = { etag: 'original', bindings: [] };
    let current = original;
    const calls: string[] = [];
    const result = await withTemporaryFirestoreRulesIam(
      'probe-project',
      { auth: {}, json: {} },
      async (iamChanged) => {
        calls.push(`work:${iamChanged}`);
        return 'done';
      },
      {
        request: async <T>(url: string, init: RequestInit) => {
          calls.push(`${init.method ?? 'GET'} ${url}`);
          if (url.endsWith('/probe-project')) return { projectNumber: '123' } as T;
          const body = init.body ? JSON.parse(String(init.body)) as { policy?: IamPolicy } : {};
          if (url.endsWith(':setIamPolicy')) current = { ...body.policy, etag: 'granted' };
          return current as T;
        },
        cleanupRequest: async <T>(url: string, init: RequestInit) => {
          calls.push(`cleanup:${init.method ?? 'GET'} ${url}`);
          const body = JSON.parse(String(init.body)) as { policy?: IamPolicy };
          if (body.policy) current = { ...body.policy, etag: 'restored' };
          return current as T;
        },
        settle: async () => { calls.push('settle'); },
      },
    );

    expect(result).toEqual({ value: 'done', iamChanged: true, iamRestored: true });
    expect(calls).toContain('work:true');
    expect(calls.filter((call) => call === 'settle')).toHaveLength(2);
    expect(canonicalPolicy(current)).toBe(canonicalPolicy(original));
  });

  test('does not rewrite or restore an existing unconditional grant', async () => {
    const role = 'roles/firebaserules.firestoreServiceAgent';
    const member = 'serviceAccount:service-123@gcp-sa-firebasestorage.iam.gserviceaccount.com';
    const policy: IamPolicy = { bindings: [{ role, members: [member] }] };
    let writes = 0;
    let cleanupRequests = 0;
    const result = await withTemporaryFirestoreRulesIam(
      'probe-project',
      { auth: {}, json: {} },
      async (iamChanged) => iamChanged,
      {
        request: async <T>(url: string, init: RequestInit) => {
          if (url.endsWith('/probe-project')) return { projectNumber: '123' } as T;
          if (init.body && (JSON.parse(String(init.body)) as { policy?: IamPolicy }).policy) writes += 1;
          return policy as T;
        },
        cleanupRequest: async <T>() => {
          cleanupRequests += 1;
          return policy as T;
        },
      },
    );

    expect(result).toEqual({ value: false, iamChanged: false, iamRestored: true });
    expect(writes).toBe(0);
    expect(cleanupRequests).toBe(0);
  });

  test('restores the original policy when probe work throws', async () => {
    const original: IamPolicy = { etag: 'original', bindings: [] };
    let current = original;
    let cleanupRequests = 0;
    const operation = withTemporaryFirestoreRulesIam(
      'probe-project',
      { auth: {}, json: {} },
      async () => { throw new Error('probe failed'); },
      {
        request: async <T>(url: string, init: RequestInit) => {
          if (url.endsWith('/probe-project')) return { projectNumber: '123' } as T;
          const body = init.body ? JSON.parse(String(init.body)) as { policy?: IamPolicy } : {};
          if (url.endsWith(':setIamPolicy')) current = { ...body.policy, etag: 'granted' };
          return current as T;
        },
        cleanupRequest: async <T>(_url: string, init: RequestInit) => {
          cleanupRequests += 1;
          const body = JSON.parse(String(init.body)) as { policy?: IamPolicy };
          if (body.policy) current = { ...body.policy, etag: 'restored' };
          return current as T;
        },
      },
    );

    await expect(operation).rejects.toThrow('probe failed');
    expect(cleanupRequests).toBeGreaterThanOrEqual(3);
    expect(canonicalPolicy(current)).toBe(canonicalPolicy(original));
  });
});
