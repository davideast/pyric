import { describe, expect, test } from 'bun:test';
import {
  MAX_DEPLOYED_RULES_CACHE_ENTRIES,
  createDeployedRulesStore,
  type DeployedRulesHealthStatus,
  type DeployedRulesServiceHealth,
} from '../../../src/serve/observed-session/deployed-rules-store.js';
import type { DeployedRulesTokenProvider } from '../../../src/serve/observed-session/deployed-rules-auth.js';
import { FIREBASE_RULES_API_ORIGIN } from '../../../src/serve/observed-session/deployed-rules-http.js';

const SECRET_TOKEN = 'live-dev-cli-token-secret';

const DEPLOYED_FIRESTORE = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /users/{uid} {',
  '      allow read, write: if request.auth != null && request.auth.uid == uid;',
  '    }',
  '  }',
  '}',
].join('\n');

const LOCAL_FIRESTORE_OPEN = DEPLOYED_FIRESTORE.replace(
  'request.auth != null && request.auth.uid == uid',
  'true',
);

const DEPLOYED_STORAGE = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /private/{uid}/{file} {',
  '      allow read: if request.auth != null && request.auth.uid == uid;',
  '    }',
  '  }',
  '}',
].join('\n');

const DEPLOYED_RTDB = {
  rules: {
    '.read': false,
    users: {
      $uid: {
        '.read': 'auth != null && auth.uid == $uid',
        '.write': 'auth != null && auth.uid == $uid',
      },
    },
  },
};

function stubTokenProvider(
  token = SECRET_TOKEN,
  source: 'firebase-cli' | 'adc' = 'firebase-cli',
): { provider: DeployedRulesTokenProvider } {
  const provider: DeployedRulesTokenProvider = {
    async resolveToken() {
      return { ok: true, source, token, expiresAt: Date.now() + 600_000 };
    },
  };
  return { provider };
}

function mockRulesFetch(routes: Record<string, Response | (() => Response)>): {
  fetchImpl: typeof fetch;
  requests: string[];
} {
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (init?.method !== 'GET') {
      throw new Error(`Forbidden non-GET method: ${String(init?.method)}`);
    }
    const handler = routes[url];
    if (handler === undefined) {
      return new Response('not found', { status: 404 });
    }
    return typeof handler === 'function' ? handler() : handler.clone();
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe('createDeployedRulesStore', () => {
  test('is strictly OFF by default: makes zero token reads, zero network calls, and omits health status', async () => {
    let tokenCalls = 0;
    let fetchCalls = 0;
    const store = createDeployedRulesStore({
      projectId: 'demo-proj',
      tokenProvider: {
        async resolveToken() {
          tokenCalls += 1;
          return { ok: true, source: 'firebase-cli', token: SECRET_TOKEN, expiresAt: Date.now() + 60_000 };
        },
      },
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });

    expect(store.enabled).toBe(false);
    expect(store.status()).toBeUndefined();
    expect(await store.getFirestore({ localRulesText: DEPLOYED_FIRESTORE })).toEqual({ ok: false, disabled: true });
    expect(await store.getStorage({ localRulesText: DEPLOYED_STORAGE })).toEqual({ ok: false, disabled: true });
    expect(await store.getRtdb({ localRulesText: JSON.stringify(DEPLOYED_RTDB) })).toEqual({ ok: false, disabled: true });
    expect(tokenCalls).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(store.status()).toBeUndefined();
  });

  test('caches fetched rules, recomputes drift when local rules change, and keeps health status credential-free', async () => {
    const releaseUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/cloud.firestore`;
    const rulesetUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-1`;
    const { fetchImpl, requests } = mockRulesFetch({
      [releaseUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/releases/cloud.firestore',
            rulesetName: 'projects/demo-proj/rulesets/rs-1',
          }),
          { status: 200 },
        ),
      [rulesetUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/rulesets/rs-1',
            source: { files: [{ name: 'firestore.rules', content: DEPLOYED_FIRESTORE }] },
          }),
          { status: 200 },
        ),
    });

    let nowMs = 1_700_000_000_000;
    const { provider } = stubTokenProvider(SECRET_TOKEN, 'adc');
    const store = createDeployedRulesStore({
      enabled: true,
      projectId: 'demo-proj',
      tokenProvider: provider,
      fetchImpl,
      now: () => nowMs,
      cacheTtlMs: 30_000,
    });

    const first = await store.getFirestore({ localRulesText: DEPLOYED_FIRESTORE });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.snapshot.drift.status).toBe('match');
    }
    expect(requests).toHaveLength(2);

    // Local rules edited: drift flips immediately from cache without network calls.
    const second = await store.getFirestore({ localRulesText: LOCAL_FIRESTORE_OPEN });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.snapshot.drift.status).toBe('drifted');
    }
    expect(requests).toHaveLength(2);

    const health: DeployedRulesHealthStatus | undefined = store.status();
    expect(health).toBeDefined();
    expect(health?.enabled).toBe(true);
    expect(health?.authSource).toBe('adc');
    expect(health?.services).toHaveLength(1);
    const firstService: DeployedRulesServiceHealth | undefined = health?.services[0];
    expect(firstService?.drift).toBe('drifted');
    expect(JSON.stringify(health)).not.toContain(SECRET_TOKEN);

    // After TTL expires, store refetches.
    nowMs += 31_000;
    const third = await store.getFirestore({ localRulesText: DEPLOYED_FIRESTORE });
    expect(third.ok).toBe(true);
    expect(requests).toHaveLength(4);
  });

  test('canonicalizes RTDB cache keys, omits invalid targets from health, and bounds cache entries', async () => {
    const rtdbUrl = 'https://demo-proj-default-rtdb.firebaseio.com/.settings/rules.json';
    const { fetchImpl, requests } = mockRulesFetch({
      [rtdbUrl]: () => new Response(JSON.stringify(DEPLOYED_RTDB), { status: 200 }),
    });
    const { provider } = stubTokenProvider();
    const store = createDeployedRulesStore({
      enabled: true,
      projectId: 'demo-proj',
      tokenProvider: provider,
      fetchImpl,
    });

    const bad = await store.getRtdb({ databaseUrlOrInstance: 'https://evil.example.com/pollute-health' });
    expect(bad.ok).toBe(false);
    expect(store.status()?.services).toEqual([]);

    const byName = await store.getRtdb({ databaseUrlOrInstance: 'demo-proj-default-rtdb' });
    const byUrl = await store.getRtdb({ databaseUrlOrInstance: 'https://demo-proj-default-rtdb.firebaseio.com/' });
    expect(byName.ok).toBe(true);
    expect(byUrl.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(store.status()?.services).toHaveLength(1);

    const manyRoutes: Record<string, () => Response> = {};
    for (let i = 0; i < MAX_DEPLOYED_RULES_CACHE_ENTRIES + 5; i += 1) {
      const db = `db-${i}`;
      manyRoutes[`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/cloud.firestore/${db}`] = () =>
        new Response(
          JSON.stringify({ rulesetName: `projects/demo-proj/rulesets/rs-${i}` }),
          { status: 200 },
        );
      manyRoutes[`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-${i}`] = () =>
        new Response(
          JSON.stringify({ source: { files: [{ name: 'firestore.rules', content: DEPLOYED_FIRESTORE }] } }),
          { status: 200 },
        );
    }
    const boundedFetch = mockRulesFetch(manyRoutes);
    const boundedStore = createDeployedRulesStore({
      enabled: true,
      projectId: 'demo-proj',
      tokenProvider: provider,
      fetchImpl: boundedFetch.fetchImpl,
    });
    for (let i = 0; i < MAX_DEPLOYED_RULES_CACHE_ENTRIES + 5; i += 1) {
      await boundedStore.getFirestore({ databaseId: `db-${i}` });
    }
    const countBeforeRefetch = boundedFetch.requests.length;
    await boundedStore.getFirestore({ databaseId: 'db-0' });
    expect(boundedFetch.requests.length).toBeGreaterThan(countBeforeRefetch);
  });
});
