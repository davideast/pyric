import { describe, expect, test } from 'bun:test';
import type { ObservedCall } from 'pyric/sandbox';
import { createDeployedRulesStore } from '../../../src/serve/observed-session/deployed-rules-store.js';
import {
  DEPLOYED_TRACE_VERSION,
  evaluateCallAgainstDeployedFirestore,
  evaluateCallAgainstDeployedRtdb,
  explainLiveCallWithDeployedRules,
} from '../../../src/serve/observed-session/deployed-rules-eval.js';
import { evaluateCallAgainstDeployedStorage } from '../../../src/serve/observed-session/deployed-rules-storage-eval.js';
import { FIREBASE_RULES_API_ORIGIN } from '../../../src/serve/observed-session/deployed-rules-http.js';
import { createObservedSessionDataStore } from '../../../src/serve/observed-session/store.js';

const SECRET_TOKEN = 'eval-secret-bearer-token';

const DEPLOYED_FIRESTORE_STRICT = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /users/{uid} {',
  '      allow read: if request.auth != null && request.auth.uid == uid;',
  '    }',
  '  }',
  '}',
].join('\n');

const LOCAL_FIRESTORE_PERMISSIVE = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /users/{uid} {',
  '      allow read: if true;',
  '    }',
  '  }',
  '}',
].join('\n');

const DEPLOYED_FIRESTORE_RESOURCE = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /orders/{id} {',
  '      allow read: if resource.data.owner == request.auth.uid;',
  '    }',
  '  }',
  '}',
].join('\n');

const DEPLOYED_RTDB_STRICT = JSON.stringify({
  rules: {
    '.read': false,
    profiles: {
      $uid: {
        '.read': 'auth != null && auth.uid === $uid',
      },
    },
  },
});

const LOCAL_RTDB_PERMISSIVE = JSON.stringify({
  rules: {
    '.read': false,
    profiles: {
      $uid: {
        '.read': true,
      },
    },
  },
});

const DEPLOYED_STORAGE_STRICT = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    match /uploads/{uid}/{file} {',
  '      allow read: if request.auth != null && request.auth.uid == uid;',
  '    }',
  '  }',
  '}',
].join('\n');

const LOCAL_STORAGE_PERMISSIVE = DEPLOYED_STORAGE_STRICT.replace(
  'request.auth != null && request.auth.uid == uid',
  'true',
);

function buildMockFetch(overrides: Record<string, Response> = {}): typeof fetch {
  const routes: Record<string, Response> = {
    [`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/cloud.firestore`]: new Response(
      JSON.stringify({
        name: 'projects/demo-proj/releases/cloud.firestore',
        rulesetName: 'projects/demo-proj/rulesets/rs-fs-strict',
      }),
      { status: 200 },
    ),
    [`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-fs-strict`]: new Response(
      JSON.stringify({
        name: 'projects/demo-proj/rulesets/rs-fs-strict',
        source: { files: [{ name: 'firestore.rules', content: DEPLOYED_FIRESTORE_STRICT }] },
      }),
      { status: 200 },
    ),
    [`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/releases/firebase.storage/demo-proj.firebasestorage.app`]:
      new Response(
        JSON.stringify({
          name: 'projects/demo-proj/releases/firebase.storage/demo-proj.firebasestorage.app',
          rulesetName: 'projects/demo-proj/rulesets/rs-st-strict',
        }),
        { status: 200 },
      ),
    [`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-st-strict`]: new Response(
      JSON.stringify({
        name: 'projects/demo-proj/rulesets/rs-st-strict',
        source: { files: [{ name: 'storage.rules', content: DEPLOYED_STORAGE_STRICT }] },
      }),
      { status: 200 },
    ),
    'https://demo-proj-default-rtdb.firebaseio.com/.settings/rules.json': new Response(DEPLOYED_RTDB_STRICT, {
      status: 200,
    }),
    ...overrides,
  };

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'GET') throw new Error(`Expected GET, saw ${String(init?.method)}`);
    const hit = routes[String(input)];
    if (hit === undefined) return new Response('not found', { status: 404 });
    return hit.clone();
  }) as typeof fetch;
}

function makeEnabledStore(fetchImpl: typeof fetch) {
  return createDeployedRulesStore({
    enabled: true,
    projectId: 'demo-proj',
    tokenProvider: {
      async resolveToken() {
        return { ok: true, source: 'firebase-cli', token: SECRET_TOKEN, expiresAt: Date.now() + 600_000 };
      },
    },
    fetchImpl,
  });
}

describe('explainLiveCallWithDeployedRules', () => {
  test('explains a live Firestore production denial against deployed rules and flags local drift', async () => {
    const store = makeEnabledStore(buildMockFetch());
    const call: ObservedCall = {
      service: 'firestore',
      method: 'getDoc',
      path: 'users/alice',
      at: 1_700_000_000_000,
      account: { uid: 'bob' },
      outcome: { status: 'error', code: 'permission-denied', message: 'Missing or insufficient permissions.' },
    };

    const result = await explainLiveCallWithDeployedRules({
      call,
      store,
      localRules: { firestore: LOCAL_FIRESTORE_PERMISSIVE },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.explanation.source).toBe('deployed');
    expect(result.explanation.service).toBe('firestore');
    expect(result.explanation.verdict).toBe('deny');
    expect(result.explanation.productionDisagrees).toBe(false);
    expect(result.explanation.rule?.line).toBe(5);
    expect(result.explanation.rule?.expression).toContain('request.auth.uid == uid');
    expect(result.explanation.trace?.version).toBe(DEPLOYED_TRACE_VERSION);
    expect(result.explanation.trace?.decision).toBe('DENY');
    expect(result.explanation.drift.drifted).toBe(true);
    expect(result.explanation.drift.firstDiffLine).toBe(5);
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  test('uses observed sessionData for deployed Firestore resource checks and abstains when missing', async () => {
    const fetchImpl = buildMockFetch({
      [`${FIREBASE_RULES_API_ORIGIN}/v1/projects/demo-proj/rulesets/rs-fs-strict`]: new Response(
        JSON.stringify({
          name: 'projects/demo-proj/rulesets/rs-fs-strict',
          source: { files: [{ name: 'firestore.rules', content: DEPLOYED_FIRESTORE_RESOURCE }] },
        }),
        { status: 200 },
      ),
    });
    const store = makeEnabledStore(fetchImpl);
    const call: ObservedCall = {
      service: 'firestore',
      method: 'getDoc',
      path: 'orders/ord-1',
      at: 1_700_000_000_000,
      account: { uid: 'bob' },
      outcome: { status: 'error', code: 'permission-denied' },
    };

    const withoutSession = await explainLiveCallWithDeployedRules({ call, store });
    expect(withoutSession.ok).toBe(true);
    if (withoutSession.ok) {
      expect(withoutSession.explanation.verdict).toBe('unevaluated');
      expect(withoutSession.explanation.needs).toContain('stored-document');
    }

    const sessionData = createObservedSessionDataStore({ projectId: 'demo-proj' });
    sessionData.apply({
      firestore: [{ kind: 'set', path: 'orders/ord-1', data: { owner: 'alice' } }],
    });
    const withSession = await explainLiveCallWithDeployedRules({ call, store, sessionData });
    expect(withSession.ok).toBe(true);
    if (withSession.ok) {
      expect(withSession.explanation.verdict).toBe('deny');
      expect(withSession.explanation.productionDisagrees).toBe(false);
    }
  });

  test('explains a live RTDB production denial against deployed rules and flags semantic drift', async () => {
    const store = makeEnabledStore(buildMockFetch());
    const call: ObservedCall = {
      service: 'rtdb',
      method: 'get',
      path: '/profiles/alice',
      at: 1_700_000_000_000,
      account: { uid: 'bob' },
      outcome: { status: 'error', code: 'permission-denied' },
    };

    const result = await explainLiveCallWithDeployedRules({
      call,
      store,
      localRules: { rtdb: LOCAL_RTDB_PERMISSIVE },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.explanation.source).toBe('deployed');
    expect(result.explanation.service).toBe('rtdb');
    expect(result.explanation.verdict).toBe('deny');
    expect(result.explanation.productionDisagrees).toBe(false);
    expect(result.explanation.rule?.path).toBe('/profiles/$uid');
    expect(result.explanation.rule?.expression).toContain('auth.uid === $uid');
    expect(result.explanation.rtdb?.matchedPath).toBe('/profiles/$uid');
    expect(result.explanation.drift.drifted).toBe(true);
    expect(result.explanation.drift.rtdbChanges).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  test('abstains as unevaluated when deployed RTDB rules inspect uncaptured stored data, and decides once sessionData captures it', async () => {
    const rtdbDataRule = JSON.stringify({
      rules: {
        '.read': false,
        rooms: {
          $roomId: {
            '.read': "data.child('owner').val() === auth.uid",
          },
        },
      },
    });
    const store = makeEnabledStore(
      buildMockFetch({
        'https://demo-proj-default-rtdb.firebaseio.com/.settings/rules.json': new Response(rtdbDataRule, {
          status: 200,
        }),
      }),
    );
    const call: ObservedCall = {
      service: 'rtdb',
      method: 'get',
      path: '/rooms/r1',
      at: 1_700_000_000_000,
      account: { uid: 'bob' },
      outcome: { status: 'error', code: 'permission-denied' },
    };

    const uncaptured = await explainLiveCallWithDeployedRules({ call, store });
    expect(uncaptured.ok).toBe(true);
    if (uncaptured.ok) {
      expect(uncaptured.explanation.verdict).toBe('unevaluated');
      expect(uncaptured.explanation.needs).toContain('stored-document');
    }

    const sessionData = createObservedSessionDataStore({ projectId: 'demo-proj' });
    sessionData.apply({
      rtdb: [{ kind: 'set', instance: 'demo-proj-default-rtdb', path: '/rooms/r1', value: { owner: 'alice' } }],
    });
    const captured = await explainLiveCallWithDeployedRules({ call, store, sessionData });
    expect(captured.ok).toBe(true);
    if (captured.ok) {
      expect(captured.explanation.verdict).toBe('deny');
      expect(captured.explanation.productionDisagrees).toBe(false);
    }
  });

  test('abstains as unevaluated when deployed RTDB rules need missing writeData or auth.token claims', async () => {
    const rtdbClaimAndWriteRules = JSON.stringify({
      rules: {
        '.read': false,
        adminDocs: {
          $id: {
            '.read': 'auth.token.admin === true',
            '.write': 'auth != null && newData.isString()',
          },
        },
      },
    });
    const store = makeEnabledStore(
      buildMockFetch({
        'https://demo-proj-default-rtdb.firebaseio.com/.settings/rules.json': new Response(
          rtdbClaimAndWriteRules,
          { status: 200 },
        ),
      }),
    );

    const claimCall: ObservedCall = {
      service: 'rtdb',
      method: 'get',
      path: '/adminDocs/d1',
      at: 1_700_000_000_000,
      account: { uid: 'bob' },
      outcome: { status: 'error', code: 'permission-denied' },
    };
    const claimRes = await explainLiveCallWithDeployedRules({ call: claimCall, store });
    expect(claimRes.ok).toBe(true);
    if (claimRes.ok) {
      expect(claimRes.explanation.verdict).toBe('unevaluated');
      expect(claimRes.explanation.needs).toContain('claim-values');
    }

    const writeCall: ObservedCall = {
      service: 'rtdb',
      method: 'set',
      path: '/adminDocs/d1',
      at: 1_700_000_000_000,
      account: { uid: 'bob' },
      outcome: { status: 'error', code: 'permission-denied' },
    };
    const writeRes = await explainLiveCallWithDeployedRules({ call: writeCall, store });
    expect(writeRes.ok).toBe(true);
    if (writeRes.ok) {
      expect(writeRes.explanation.verdict).toBe('unevaluated');
      expect(writeRes.explanation.needs).toContain('write-data');
    }
  });

  test('explains a live Storage production denial against deployed rules and flags local drift', async () => {
    const store = makeEnabledStore(buildMockFetch());
    const call: ObservedCall = {
      service: 'storage',
      method: 'getDownloadURL',
      bucket: 'demo-proj.firebasestorage.app',
      path: 'uploads/alice/photo.png',
      at: 1_700_000_000_000,
      account: { uid: 'bob' },
      outcome: { status: 'error', code: 'storage/unauthorized' },
    };

    const result = await explainLiveCallWithDeployedRules({
      call,
      store,
      localRules: { storage: LOCAL_STORAGE_PERMISSIVE },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.explanation.source).toBe('deployed');
    expect(result.explanation.service).toBe('storage');
    expect(result.explanation.verdict).toBe('deny');
    expect(result.explanation.productionDisagrees).toBe(false);
    expect(result.explanation.storage?.matchedPath).toContain('uploads');
    expect(result.explanation.storage?.matchedLine).toBe(5);
    expect(result.explanation.drift.drifted).toBe(true);
    expect(JSON.stringify(result)).not.toContain(SECRET_TOKEN);
  });

  test('degrades cleanly to source local when disabled, unauthenticated, or called for Admin SDK', async () => {
    let fetchCalls = 0;
    const disabledStore = createDeployedRulesStore({
      projectId: 'demo-proj',
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    });

    const call: ObservedCall = {
      service: 'firestore',
      method: 'getDoc',
      path: 'users/alice',
      at: 1_700_000_000_000,
      account: { uid: 'bob' },
      outcome: { status: 'error', code: 'permission-denied' },
    };

    const disabledRes = await explainLiveCallWithDeployedRules({ call, store: disabledStore });
    expect(disabledRes.ok).toBe(false);
    if (!disabledRes.ok) {
      expect(disabledRes.source).toBe('local');
      expect(disabledRes.reason).toBe('disabled');
    }
    expect(fetchCalls).toBe(0);

    const unauthStore = createDeployedRulesStore({
      enabled: true,
      projectId: 'demo-proj',
      tokenProvider: {
        async resolveToken() {
          return { ok: false, code: 'unauthenticated', message: 'No developer CLI login found.' };
        },
      },
    });
    const unauthRes = await explainLiveCallWithDeployedRules({ call, store: unauthStore });
    expect(unauthRes.ok).toBe(false);
    if (!unauthRes.ok) {
      expect(unauthRes.source).toBe('local');
      expect(unauthRes.reason).toBe('unauthenticated');
    }

    const enabledStore = makeEnabledStore(buildMockFetch());
    const adminCall: ObservedCall = { ...call, sdk: 'admin' };
    const adminRes = await explainLiveCallWithDeployedRules({ call: adminCall, store: enabledStore });
    expect(adminRes.ok).toBe(false);
    if (!adminRes.ok) {
      expect(adminRes.source).toBe('local');
      expect(adminRes.reason).toBe('unsupported-call');
    }

    const fsSnap = await enabledStore.getFirestore();
    if (fsSnap.ok) {
      expect(evaluateCallAgainstDeployedFirestore(adminCall, fsSnap.snapshot).ok).toBe(false);
    }
    const rtdbSnap = await enabledStore.getRtdb();
    if (rtdbSnap.ok) {
      expect(evaluateCallAgainstDeployedRtdb(adminCall, rtdbSnap.snapshot).ok).toBe(false);
    }
    const storageSnap = await enabledStore.getStorage();
    if (storageSnap.ok) {
      expect(evaluateCallAgainstDeployedStorage(adminCall, storageSnap.snapshot).ok).toBe(false);
    }
  });
});
