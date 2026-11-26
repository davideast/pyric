import { describe, expect, test } from 'bun:test';
import {
  readDeployedFirestoreRules,
  readDeployedRtdbRules,
  readDeployedStorageRules,
  type DeployedRulesSourceFile,
} from '../../../src/serve/observed-session/deployed-rules.js';
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
): { provider: DeployedRulesTokenProvider; calls: () => number } {
  let count = 0;
  const provider: DeployedRulesTokenProvider = {
    async resolveToken() {
      count += 1;
      return { ok: true, source, token, expiresAt: Date.now() + 600_000 };
    },
  };
  return { provider, calls: () => count };
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string | undefined;
  readonly redirect: RequestRedirect | undefined;
  readonly authHeader: string | undefined;
}

function mockRulesFetch(routes: Record<string, Response | (() => Response)>): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({
      url,
      method: init?.method,
      redirect: init?.redirect,
      authHeader: headers.Authorization,
    });
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

describe('deployed-rules readers', () => {
  test('reads default and named Firestore database releases with read-only GET and detects drift', async () => {
    const defaultReleaseUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/cloud.firestore`;
    const namedReleaseUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/cloud.firestore/analytics`;
    const rulesetUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-fs-1`;
    const namedRulesetUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-fs-2`;

    const { fetchImpl, requests } = mockRulesFetch({
      [defaultReleaseUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/releases/cloud.firestore',
            rulesetName: 'projects/demo-proj/rulesets/rs-fs-1',
          }),
          { status: 200 },
        ),
      [rulesetUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/rulesets/rs-fs-1',
            source: { files: [{ name: 'firestore.rules', content: DEPLOYED_FIRESTORE }] },
          }),
          { status: 200 },
        ),
      [namedReleaseUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/releases/cloud.firestore/analytics',
            rulesetName: 'projects/demo-proj/rulesets/rs-fs-2',
          }),
          { status: 200 },
        ),
      [namedRulesetUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/rulesets/rs-fs-2',
            source: { files: [{ name: 'analytics.rules', content: DEPLOYED_FIRESTORE }] },
          }),
          { status: 200 },
        ),
    });

    const { provider } = stubTokenProvider();
    const drifted = await readDeployedFirestoreRules({
      projectId: 'demo-proj',
      localRulesText: LOCAL_FIRESTORE_OPEN,
      tokenProvider: provider,
      fetchImpl,
    });
    expect(drifted.ok).toBe(true);
    if (drifted.ok) {
      expect(drifted.snapshot.databaseId).toBe('(default)');
      expect(drifted.snapshot.rulesetId).toBe('rs-fs-1');
      expect(drifted.snapshot.drift.drifted).toBe(true);
      expect(drifted.snapshot.drift.status).toBe('drifted');
      expect(drifted.snapshot.drift.firstDiffLine).toBe(5);
    }

    const named = await readDeployedFirestoreRules({
      projectId: 'demo-proj',
      databaseId: 'analytics',
      localRulesText: DEPLOYED_FIRESTORE,
      tokenProvider: provider,
      fetchImpl,
    });
    expect(named.ok).toBe(true);
    if (named.ok) {
      expect(named.snapshot.databaseId).toBe('analytics');
      expect(named.snapshot.rulesetId).toBe('rs-fs-2');
      expect(named.snapshot.drift.drifted).toBe(false);
      expect(named.snapshot.drift.status).toBe('match');
    }

    expect(requests).toHaveLength(4);
    for (const req of requests) {
      expect(req.method).toBe('GET');
      expect(req.redirect).toBe('manual');
      expect(req.authHeader).toBe(`Bearer ${SECRET_TOKEN}`);
    }
  });

  test('rejects a cross-project rulesetName from a release response before issuing a second GET', async () => {
    const releaseUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/cloud.firestore`;
    const { fetchImpl, requests } = mockRulesFetch({
      [releaseUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/releases/cloud.firestore',
            rulesetName: 'projects/attacker-proj/rulesets/rs-cross-project',
          }),
          { status: 200 },
        ),
    });

    const { provider } = stubTokenProvider();
    const res = await readDeployedFirestoreRules({
      projectId: 'demo-proj',
      tokenProvider: provider,
      fetchImpl,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && !res.disabled) {
      expect(res.error.code).toBe('invalid-target');
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(releaseUrl);
  });

  test('reads Storage release and falls back from firebasestorage.app to appspot.com on 404', async () => {
    const legacyReleaseUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/firebase.storage/demo-proj.appspot.com`;
    const rulesetUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-st-1`;
    const { fetchImpl, requests } = mockRulesFetch({
      [legacyReleaseUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/releases/firebase.storage/demo-proj.appspot.com',
            rulesetName: 'projects/demo-proj/rulesets/rs-st-1',
          }),
          { status: 200 },
        ),
      [rulesetUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/rulesets/rs-st-1',
            source: { files: [{ name: 'storage.rules', content: DEPLOYED_STORAGE }] },
          }),
          { status: 200 },
        ),
    });

    const { provider } = stubTokenProvider();
    const res = await readDeployedStorageRules({
      projectId: 'demo-proj',
      localRulesText: DEPLOYED_STORAGE.replace('request.auth.uid == uid', 'true'),
      tokenProvider: provider,
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.bucket).toBe('demo-proj.appspot.com');
      expect(res.snapshot.drift.drifted).toBe(true);
    }
    expect(requests.map((r) => r.url)).toEqual([
      `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/firebase.storage/demo-proj.firebasestorage.app`,
      legacyReleaseUrl,
      rulesetUrl,
    ]);
  });

  test('reads RTDB .settings/rules.json over allowlisted regional host and rejects non-Firebase hosts before resolving token', async () => {
    const regionalUrl = 'https://demo-eu.europe-west1.firebasedatabase.app/.settings/rules.json';
    const { fetchImpl, requests } = mockRulesFetch({
      [regionalUrl]: () => new Response(JSON.stringify(DEPLOYED_RTDB), { status: 200 }),
    });
    const { provider, calls } = stubTokenProvider();

    const blocked = await readDeployedRtdbRules({
      databaseUrlOrInstance: 'https://evil.example.com',
      tokenProvider: provider,
      fetchImpl,
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok && !blocked.disabled) {
      expect(blocked.error.code).toBe('invalid-host');
    }
    expect(calls()).toBe(0);
    expect(requests).toHaveLength(0);

    const localDrifted = JSON.stringify({
      rules: {
        '.read': false,
        users: { $uid: { '.read': 'true', '.write': 'auth != null && auth.uid == $uid' } },
      },
    });
    const ok = await readDeployedRtdbRules({
      databaseUrlOrInstance: 'https://demo-eu.europe-west1.firebasedatabase.app',
      localRulesText: localDrifted,
      tokenProvider: provider,
      fetchImpl,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.snapshot.instance).toBe('demo-eu');
      expect(ok.snapshot.drift.drifted).toBe(true);
      expect(ok.snapshot.drift.rtdbChanges).toHaveLength(1);
    }
    expect(calls()).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.redirect).toBe('manual');
  });

  test('selects primary entry file for multi-file rulesets and ignores cross-project release.name', async () => {
    const releaseUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/cloud.firestore`;
    const rulesetUrl = `${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-multi`;
    const { fetchImpl } = mockRulesFetch({
      [releaseUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/other-proj/releases/cloud.firestore',
            rulesetName: 'projects/demo-proj/rulesets/rs-multi',
          }),
          { status: 200 },
        ),
      [rulesetUrl]: () =>
        new Response(
          JSON.stringify({
            name: 'projects/demo-proj/rulesets/rs-multi',
            source: {
              files: [
                { name: 'helpers.rules', content: 'function helper() { return true; }' },
                { name: 'firestore.rules', content: DEPLOYED_FIRESTORE },
              ],
            },
          }),
          { status: 200 },
        ),
    });

    const { provider } = stubTokenProvider();
    const res = await readDeployedFirestoreRules({
      projectId: 'demo-proj',
      localRulesText: DEPLOYED_FIRESTORE,
      tokenProvider: provider,
      fetchImpl,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.releaseName).toBe('projects/demo-proj/releases/cloud.firestore');
      expect(res.snapshot.source).toBe(DEPLOYED_FIRESTORE);
      const files: readonly DeployedRulesSourceFile[] = res.snapshot.files;
      expect(files).toHaveLength(2);
      expect(res.snapshot.drift.status).toBe('match');
    }
  });
});
