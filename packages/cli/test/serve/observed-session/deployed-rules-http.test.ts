import { describe, expect, test } from 'bun:test';
import {
  FIREBASE_RULES_API_ORIGIN,
  MAX_DEPLOYED_RULES_RESPONSE_BYTES,
  isAllowedDeployedRulesUrl,
  readOnlyRulesGet,
  resolveAllowedRtdbRulesUrl,
  validateFirestoreDatabaseId,
  validateProjectId,
  validateRulesetResourceName,
  validateStorageBucketId,
} from '../../../src/serve/observed-session/deployed-rules-http.js';

describe('deployed-rules-http validation and host allowlist', () => {
  test('validates project IDs, database IDs, bucket IDs, and ruleset resource names strictly', () => {
    expect(validateProjectId('demo-project-1')).toBe('demo-project-1');
    expect(validateProjectId('../escape')).toBeNull();
    expect(validateProjectId('demo/other')).toBeNull();
    expect(validateProjectId('demo?x=1')).toBeNull();

    expect(validateFirestoreDatabaseId('(default)')).toBe('(default)');
    expect(validateFirestoreDatabaseId('analytics-db')).toBe('analytics-db');
    expect(validateFirestoreDatabaseId('../other')).toBeNull();
    expect(validateFirestoreDatabaseId('bad/name')).toBeNull();

    expect(validateStorageBucketId('demo-proj.firebasestorage.app')).toBe('demo-proj.firebasestorage.app');
    expect(validateStorageBucketId('demo-proj.appspot.com')).toBe('demo-proj.appspot.com');
    expect(validateStorageBucketId('demo..evil')).toBeNull();
    expect(validateStorageBucketId('bucket/path')).toBeNull();

    expect(validateRulesetResourceName('projects/demo-proj/rulesets/abc-123_def', 'demo-proj')).toBe(
      'projects/demo-proj/rulesets/abc-123_def',
    );
    expect(validateRulesetResourceName('projects/other-proj/rulesets/abc-123_def', 'demo-proj')).toBeNull();
    expect(validateRulesetResourceName('projects/123456789/rulesets/rs_1', '123456789')).toBe(
      'projects/123456789/rulesets/rs_1',
    );
    expect(validateRulesetResourceName('projects/demo/rulesets/has.dot', 'demo')).toBeNull();
    expect(validateRulesetResourceName('projects/demo/rulesets/../releases/cloud.firestore', 'demo')).toBeNull();
    expect(validateRulesetResourceName('https://evil.example/projects/demo/rulesets/1', 'demo')).toBeNull();
  });

  test('resolves allowlisted RTDB targets and rejects arbitrary or non-HTTPS hosts', () => {
    expect(resolveAllowedRtdbRulesUrl('demo-default-rtdb')).toBe(
      'https://demo-default-rtdb.firebaseio.com/.settings/rules.json',
    );
    expect(resolveAllowedRtdbRulesUrl('https://demo-default-rtdb.firebaseio.com/')).toBe(
      'https://demo-default-rtdb.firebaseio.com/.settings/rules.json',
    );
    expect(resolveAllowedRtdbRulesUrl('https://demo-db.europe-west1.firebasedatabase.app')).toBe(
      'https://demo-db.europe-west1.firebasedatabase.app/.settings/rules.json',
    );

    const rejected = [
      'http://demo-default-rtdb.firebaseio.com',
      'https://localhost:8080',
      'https://127.0.0.1',
      'https://169.254.169.254/latest/meta-data',
      'https://evil.example.com',
      'https://demo.firebaseio.com.evil.example',
      'https://user:pass@demo-default-rtdb.firebaseio.com',
      'https://demo-default-rtdb.firebaseio.com:8443',
      'https://demo-default-rtdb.firebaseio.com/other/path',
      'https://demo-default-rtdb.firebaseio.com/?auth=leak',
    ];
    for (const bad of rejected) {
      expect(resolveAllowedRtdbRulesUrl(bad)).toBeNull();
    }
  });

  test('enforces strict URL allowlist including path traversal rejection', () => {
    expect(isAllowedDeployedRulesUrl(`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo/releases/cloud.firestore`)).toBe(true);
    expect(
      isAllowedDeployedRulesUrl(
        `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo/releases/firebase.storage/demo.firebasestorage.app`,
      ),
    ).toBe(true);
    expect(isAllowedDeployedRulesUrl('https://demo-default-rtdb.firebaseio.com/.settings/rules.json')).toBe(true);
    expect(isAllowedDeployedRulesUrl('https://demo.asia-southeast1.firebasedatabase.app/.settings/rules.json')).toBe(true);

    expect(isAllowedDeployedRulesUrl('https://evil.example/v1/projects/demo/releases/cloud.firestore')).toBe(false);
    expect(isAllowedDeployedRulesUrl('http://firebaserules.googleapis.com/v1/projects/demo/releases/cloud.firestore')).toBe(false);
    expect(isAllowedDeployedRulesUrl(`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo/releases/..%2Fother`)).toBe(false);
    expect(isAllowedDeployedRulesUrl(`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo/releases/cloud.firestore?token=1`)).toBe(false);
    expect(isAllowedDeployedRulesUrl('https://demo-default-rtdb.firebaseio.com/users.json')).toBe(false);
  });
});

describe('readOnlyRulesGet', () => {
  test('issues read-only GET with redirect manual and Bearer Authorization header only', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    const url = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo/releases/cloud.firestore`;
    const res = await readOnlyRulesGet({ url, token: 'secret-bearer-token', fetchImpl });
    expect(res).toEqual({ ok: true, text: '{"ok":true}' });
    expect(seenUrl).toBe(url);
    expect(seenUrl).not.toContain('secret-bearer-token');
    expect(seenInit?.method).toBe('GET');
    expect(seenInit?.redirect).toBe('manual');
    expect((seenInit?.headers as Record<string, string>).Authorization).toBe('Bearer secret-bearer-token');
  });

  test('refuses non-allowlisted URLs without invoking fetch', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const res = await readOnlyRulesGet({
      url: 'https://evil.example/v1/projects/demo/releases/cloud.firestore',
      token: 'secret-bearer-token',
      fetchImpl,
    });
    expect(called).toBe(false);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid-host');
      expect(JSON.stringify(res)).not.toContain('secret-bearer-token');
    }
  });

  test('blocks 3xx redirects so Authorization headers cannot be forwarded', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 307, headers: { location: 'https://evil.example/capture' } })) as typeof fetch;

    const res = await readOnlyRulesGet({
      url: `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo/releases/cloud.firestore`,
      token: 'secret-bearer-token',
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('redirect-blocked');
      expect(res.error.status).toBe(307);
      expect(JSON.stringify(res)).not.toContain('secret-bearer-token');
      expect(JSON.stringify(res)).not.toContain('evil.example');
    }
  });

  test('maps 401, 403, 404, 500, network errors, and oversized bodies without leaking tokens or raw bodies', async () => {
    const url = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo/releases/cloud.firestore`;
    const secret = 'secret-bearer-token-999';
    const cases: Array<{ status: number; expected: string }> = [
      { status: 401, expected: 'unauthenticated' },
      { status: 403, expected: 'permission-denied' },
      { status: 404, expected: 'not-found' },
      { status: 503, expected: 'http-error' },
    ];
    for (const item of cases) {
      const fetchImpl = (async () =>
        new Response(`upstream echo ${secret} raw-body-marker`, { status: item.status })) as typeof fetch;
      const res = await readOnlyRulesGet({ url, token: secret, fetchImpl });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(item.expected);
        const serialized = JSON.stringify(res);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toContain('raw-body-marker');
      }
    }

    const throwingFetch = (async () => {
      throw new Error(`socket failed with Authorization: Bearer ${secret}`);
    }) as typeof fetch;
    const netErr = await readOnlyRulesGet({ url, token: secret, fetchImpl: throwingFetch });
    expect(netErr.ok).toBe(false);
    if (!netErr.ok) {
      expect(netErr.error.code).toBe('network-error');
      expect(JSON.stringify(netErr)).not.toContain(secret);
    }

    expect(MAX_DEPLOYED_RULES_RESPONSE_BYTES).toBe(2 * 1024 * 1024);
    const oversizedFetch = (async () => new Response('x'.repeat(2048), { status: 200 })) as typeof fetch;
    const tooLarge = await readOnlyRulesGet({ url, token: secret, fetchImpl: oversizedFetch, maxBytes: 128 });
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) {
      expect(tooLarge.error.code).toBe('response-too-large');
    }
  });
});
