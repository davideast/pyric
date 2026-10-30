/**
 * Oracle conformance for `pyric/app-check` (surface `app-check`), authored red
 * under Conformance Driven Development (docs/conformance/cdd.md, Step 3).
 *
 * One assertion set per `app-check` row in packages/conformance/registry/app-check.ts.
 * Where a row cites an `app-check-` capture, the capture's recorded values are
 * the expected side, loaded through the observation gate, and the sandbox is
 * driven to produce the same facts. Token shapes are compared with the rig's
 * own reducer (`jwtShape`), so the suite and the capture describe a token the
 * same way.
 *
 * Blocking run: only expected-green rows (`conforms`, `diverged-documented`)
 * run. The climb lane (`PYRIC_CLIMB=1`) runs every row and the prefix
 * completeness gate; the gate needs every row's loads, so it runs only there.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Token length is not claimed (see the rows' notes): the shape comparison drops it explicitly. */
const WITHOUT_LENGTH = { length: undefined };
import { appCheckRows } from '../../../conformance/registry/app-check.ts';
import { createObservationGate } from '../../../conformance/src/observation-gate.ts';
import { jwtShape, type Secrets } from '../../../conformance/src/capture/app-check/redact.ts';
import { initializeApp } from 'pyric/app';
import * as appCheck from 'pyric/app-check';
import { resetAppRegistryForTests } from '../../dist/app/registry.js';

const isClimb = process.env.PYRIC_CLIMB === '1';
const REPO = join(import.meta.dir, '..', '..', '..', '..');
const OBS_DIR = join(REPO, 'packages', 'conformance', 'observations', 'app-check');
const AI_SUITE = join(REPO, 'packages', 'cli', 'test', 'serve', 'ai-app-check-passthrough.test.ts');

const gate = createObservationGate({
  dir: OBS_DIR,
  match: (file) => file.startsWith('app-check-'),
  // The AI-path captures are replayed by the AI pass-through suite.
  siblingSources: [AI_SUITE],
});
const obs = gate.load;

/** The project of an app whose token shape no capture pins. */
const PROJECT_ID = 'digame-mas';
const PROJECT_NUMBER = '123456789012';
const APP_ID = `1:${PROJECT_NUMBER}:web:0a1b2c3d4e5f60718293a4`;
const OPTIONS = { apiKey: 'demo-api-key', appId: APP_ID, projectId: PROJECT_ID };
const SECRETS: Secrets = { appId: APP_ID, apiKey: OPTIONS.apiKey, projectNumber: PROJECT_NUMBER, values: [] };

/** The oracle project a capture ran against, so a token's audience compares directly. */
function observedProject(name: string): string {
  return (JSON.parse(readFileSync(join(OBS_DIR, `${name}.json`), 'utf8')) as { projectId: string }).projectId;
}

let appSeq = 0;
function freshApp(label: string, projectId = PROJECT_ID) {
  appSeq += 1;
  return initializeApp({ ...OPTIONS, projectId }, `${label}-${appSeq}`);
}
function provider() {
  return new appCheck.CustomProvider({
    getToken: async () => {
      throw new Error('the sandbox must not call the attestation provider');
    },
  });
}
function errorFacts(error: unknown) {
  const e = error as { name?: string; code?: string; message?: string; customData?: Record<string, unknown> };
  return {
    threw: true,
    name: e.name ?? null,
    code: e.code ?? null,
    message: String(e.message),
    customDataKeys: e.customData ? Object.keys(e.customData).sort() : [],
    customData: e.customData ?? null,
  };
}
async function rejection(operation: () => Promise<unknown> | unknown) {
  try {
    await operation();
  } catch (error) {
    return errorFacts(error);
  }
  return { threw: false };
}
/** Observed messages name the app the capture used; swap in the sandbox app's name. */
function withAppName(message: string, observedName: string, name: string): string {
  return message.replace(`FirebaseApp ${observedName}`, `FirebaseApp ${name}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type DebugGlobal = { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown };

// One Firebase configuration per runtime: start from an empty registry. The
// browser captures attest through a registered debug token, so the suite runs
// with one set, as they did; a row about the provider path clears it.
beforeAll(async () => {
  await resetAppRegistryForTests();
  (globalThis as DebugGlobal).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
});
afterAll(() => {
  delete (globalThis as DebugGlobal).FIREBASE_APPCHECK_DEBUG_TOKEN;
});

/** Runs `operation` with no debug token set, then restores the suite's. */
async function withoutDebugToken(operation: () => Promise<void>): Promise<void> {
  delete (globalThis as DebugGlobal).FIREBASE_APPCHECK_DEBUG_TOKEN;
  try {
    await operation();
  } finally {
    (globalThis as DebugGlobal).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  }
}

type DocumentGlobal = { document?: unknown };

/** Runs `operation` in a realm with a `document`, as a page has; Bun has none. */
async function withStandInDocument(operation: () => Promise<void>): Promise<void> {
  (globalThis as DocumentGlobal).document = {};
  try {
    await operation();
  } finally {
    delete (globalThis as DocumentGlobal).document;
  }
}

/** A CustomProvider that counts its calls and answers with `answer`. */
function countingProvider(answer: () => Promise<{ token: string; expireTimeMillis: number }>) {
  const counter = { calls: 0 };
  const instance = new appCheck.CustomProvider({
    getToken: async () => {
      counter.calls += 1;
      return answer();
    },
  });
  return {
    instance,
    get calls(): number {
      return counter.calls;
    },
  };
}
afterEach(async () => {
  await resetAppRegistryForTests();
});

type Assertion = () => Promise<void>;
const assertions: Record<string, Assertion> = {
  'app-check#initialize-returns-handle': async () => {
    const o = obs('app-check-client-initialize-twice');
    const app = freshApp('handle');
    const handle = appCheck.initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false });
    expect(o.instanceKeySet).toContain('app');
    expect(handle.app).toBe(app);
  },

  'app-check#initialize-twice-same-options': async () => {
    const o = obs('app-check-client-initialize-twice');
    const app = freshApp('twice-same');
    const shared = provider();
    const first = appCheck.initializeAppCheck(app, { provider: shared, isTokenAutoRefreshEnabled: false });
    const same = appCheck.initializeAppCheck(app, { provider: shared, isTokenAutoRefreshEnabled: false });
    const fresh = appCheck.initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: false });
    expect({ threw: false, returnsSameInstance: same === first }).toEqual(o.sameOptions);
    expect({ threw: false, returnsSameInstance: fresh === first }).toEqual(o.sameOptionsNewProviderInstance);
  },

  'app-check#initialize-twice-different-options': async () => {
    const expected = obs('app-check-client-initialize-twice').differentAutoRefresh;
    const app = freshApp('twice-diff');
    const shared = provider();
    appCheck.initializeAppCheck(app, { provider: shared, isTokenAutoRefreshEnabled: false });
    const actual = await rejection(() => appCheck.initializeAppCheck(app, { provider: shared, isTokenAutoRefreshEnabled: true }));
    expect(actual).toEqual({
      ...expected,
      message: withAppName(expected.message, expected.customData.appName, app.name),
      customData: { appName: app.name },
    });
  },

  'app-check#initialize-twice-unset-auto-refresh': async () => {
    const o = obs('app-check-client-initialize-twice-unset-auto-refresh');
    const unset = {};
    const off = { isTokenAutoRefreshEnabled: false };
    const cases = [
      { key: 'unsetThenFalse', label: 'twice-unset-false', firstOptions: unset, secondOptions: off },
      { key: 'falseThenUnset', label: 'twice-false-unset', firstOptions: off, secondOptions: unset },
      { key: 'unsetThenUnset', label: 'twice-unset-unset', firstOptions: unset, secondOptions: unset },
    ] as const;
    for (const { key, label, firstOptions, secondOptions } of cases) {
      const expected = o[key];
      const app = freshApp(label);
      const shared = provider();
      const first = appCheck.initializeAppCheck(app, { provider: shared, ...firstOptions });
      let second: unknown;
      const outcome = await rejection(() => {
        second = appCheck.initializeAppCheck(app, { provider: shared, ...secondOptions });
      });
      if (!expected.threw) {
        expect({ threw: outcome.threw, returnsSameInstance: second === first }).toEqual(expected);
        continue;
      }
      expect(outcome).toEqual({
        ...expected,
        message: withAppName(expected.message, expected.customData.appName, app.name),
        customData: { appName: app.name },
      });
    }
  },

  'app-check#providers-construct': async () => {
    const o = obs('app-check-client-debug-get-token');
    let calls = 0;
    const custom = new appCheck.CustomProvider({
      getToken: async () => {
        calls += 1;
        throw new Error('not called');
      },
    });
    const handle = appCheck.initializeAppCheck(freshApp('provider'), { provider: custom, isTokenAutoRefreshEnabled: false });
    await appCheck.getToken(handle);
    expect(calls).toBe(o.customProviderCalls);
  },

  'app-check#custom-provider-without-debug-token': () =>
    withoutDebugToken(async () => {
      const expireTimeMillis = Date.now() + 3_600_000;
      const garbage = countingProvider(async () => ({ token: 'not-an-app-check-token', expireTimeMillis }));
      const given = appCheck.initializeAppCheck(freshApp('custom-given'), { provider: garbage.instance, isTokenAutoRefreshEnabled: false });
      expect(await appCheck.getToken(given)).toEqual({ token: 'not-an-app-check-token' });
      expect(await appCheck.getToken(given)).toEqual({ token: 'not-an-app-check-token' });
      expect(garbage.calls).toBe(1);
      expect(await appCheck.getLimitedUseToken(given)).toEqual({ token: 'not-an-app-check-token' });
      expect(garbage.calls).toBe(2);

      const failure = new Error('attestation failed');
      const failing = countingProvider(async () => {
        throw failure;
      });
      const refused = appCheck.initializeAppCheck(freshApp('custom-rejects'), { provider: failing.instance, isTokenAutoRefreshEnabled: false });
      const observed: unknown[] = [];
      const unsubscribe = appCheck.onTokenChanged(refused, () => observed.push('next'), (error) => observed.push(error));
      await expect(appCheck.getToken(refused)).rejects.toBe(failure);
      await expect(appCheck.getLimitedUseToken(refused)).rejects.toBe(failure);
      await sleep(10);
      unsubscribe();
      expect(observed).toEqual([failure]);
      expect(failing.calls).toBe(2);
    }),

  'app-check#recaptcha-providers-construct': () =>
    withStandInDocument(async () => {
      for (const provider of [new appCheck.ReCaptchaV3Provider('demo-site-key'), new appCheck.ReCaptchaEnterpriseProvider('demo-site-key')]) {
        const handle = appCheck.initializeAppCheck(freshApp('recaptcha'), { provider, isTokenAutoRefreshEnabled: false });
        expect(Object.keys(await appCheck.getToken(handle))).toEqual(['token']);
      }
    }),

  'app-check#recaptcha-providers-without-document': async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    const providers = [
      (siteKey: string) => new appCheck.ReCaptchaV3Provider(siteKey),
      (siteKey: string) => new appCheck.ReCaptchaEnterpriseProvider(siteKey),
    ];
    const attempt = (app: ReturnType<typeof freshApp>, provider: appCheck.ReCaptchaV3Provider | appCheck.ReCaptchaEnterpriseProvider) => () =>
      appCheck.initializeAppCheck(app, { provider });
    const check = async () => {
      for (const make of providers) {
        const app = freshApp('recaptcha-no-document');
        expect(attempt(app, make('demo-site-key'))).toThrow(new ReferenceError('document is not defined'));
        const handle = appCheck.initializeAppCheck(app, { provider: make('demo-site-key') });
        expect(handle.app).toBe(app);
        expect(await rejection(attempt(app, make('another-site-key')))).toMatchObject({ threw: true, code: 'appCheck/already-initialized' });
      }
    };
    await check();
    await withoutDebugToken(check);
  },

  'app-check#get-token-before-initialize': async () => {
    const expected = obs('app-check-client-get-token-before-initialize').publicGetTokenWithUninitializedApp;
    const app = freshApp('before');
    const actual = await rejection(() => appCheck.getToken({ app } as appCheck.AppCheck));
    expect(actual).toEqual({
      ...expected,
      message: withAppName(expected.message, expected.customData.appName, app.name),
      customData: { appName: app.name },
    });
  },

  'app-check#get-token-shape': async () => {
    const o = obs('app-check-client-debug-get-token');
    const handle = appCheck.initializeAppCheck(freshApp('shape', observedProject('app-check-client-debug-get-token')), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const first = await appCheck.getToken(handle);
    const forced = await appCheck.getToken(handle, true);
    const shape = (result: { token: string }) => ({ ...jwtShape(result.token, SECRETS), ...WITHOUT_LENGTH });
    const expected = (facts: { token: Record<string, unknown> }) => ({ ...facts.token, ...WITHOUT_LENGTH });
    expect(Object.keys(first).sort()).toEqual(o.first.keySet);
    expect(shape(first)).toEqual(expected(o.first));
    expect(shape(forced)).toEqual(expected(o.forced));
  },

  'app-check#get-token-caching': async () => {
    const o = obs('app-check-client-debug-get-token');
    const handle = appCheck.initializeAppCheck(freshApp('cache'), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const first = await appCheck.getToken(handle);
    const second = await appCheck.getToken(handle);
    const forced = await appCheck.getToken(handle, true);
    expect(second.token === first.token).toBe(o.secondEqualsFirst);
    expect(forced.token !== first.token).toBe(o.forceRefreshDiffersFromFirst);
  },

  'app-check#get-token-concurrent': async () => {
    const o = obs('app-check-client-get-token-concurrent');
    const handle = appCheck.initializeAppCheck(freshApp('concurrent'), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const [firstA, firstB] = await Promise.all([appCheck.getToken(handle), appCheck.getToken(handle)]);
    const [forcedA, forcedB] = await Promise.all([appCheck.getToken(handle, true), appCheck.getToken(handle, true)]);
    expect({
      concurrentFirstShareOneToken: firstB.token === firstA.token,
      concurrentForcedShareOneToken: forcedB.token === forcedA.token,
      forcedDiffersFromFirst: forcedA.token !== firstA.token,
    }).toEqual({
      concurrentFirstShareOneToken: o.concurrentFirstShareOneToken,
      concurrentForcedShareOneToken: o.concurrentForcedShareOneToken,
      forcedDiffersFromFirst: o.forcedDiffersFromFirst,
    });
  },

  'app-check#limited-use-token': async () => {
    const o = obs('app-check-client-limited-use-token');
    const handle = appCheck.initializeAppCheck(freshApp('limited', observedProject('app-check-client-limited-use-token')), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const cached = await appCheck.getToken(handle);
    const a = await appCheck.getLimitedUseToken(handle);
    const b = await appCheck.getLimitedUseToken(handle);
    const after = await appCheck.getToken(handle);
    expect(Object.keys(a).sort()).toEqual(o.limited.keySet);
    expect({ ...jwtShape(a.token, SECRETS), ...WITHOUT_LENGTH }).toEqual({ ...o.limited.token, ...WITHOUT_LENGTH });
    expect(a.token !== cached.token).toBe(o.differsFromCachedToken);
    expect(a.token !== b.token).toBe(o.twoCallsDistinct);
    expect(after.token === cached.token).toBe(o.cachedTokenAfterLimitedUseUnchanged);
  },

  'app-check#attestation-failure': async () => {
    const o = obs('app-check-client-invalid-debug-token');
    // The sandbox has no attestation authority that can refuse. The assertion
    // set states what a conforming sandbox would have to produce.
    const handle = appCheck.initializeAppCheck(freshApp('refused'), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const actual = await rejection(() => appCheck.getToken(handle));
    expect(actual).toEqual(o.getToken);
    expect(await rejection(() => appCheck.getLimitedUseToken(handle))).toEqual(o.getLimitedUseToken);
  },

  'app-check#on-token-changed-existing-token': async () => {
    const o = obs('app-check-client-on-token-changed');
    const handle = appCheck.initializeAppCheck(freshApp('late'), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const current = await appCheck.getToken(handle);
    const seen: string[] = [];
    const unsubscribe = appCheck.onTokenChanged(handle, (result) => seen.push(result.token));
    const synchronous = seen.length;
    await sleep(500);
    unsubscribe();
    expect(typeof unsubscribe).toBe(o.unsubscribeType);
    expect(synchronous).toBe(o.lateListenerCallsSynchronous);
    expect(seen.length).toBe(o.lateListenerCallsWithin500ms);
    expect(seen.map((token) => (token === current.token ? 'forcedAfterUnsubscribe' : 'other'))).toEqual(o.lateListenerTokenSequence);
  },

  'app-check#on-token-changed-refresh': async () => {
    const o = obs('app-check-client-on-token-changed');
    const handle = appCheck.initializeAppCheck(freshApp('refresh'), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const listener: string[] = [];
    const observer: string[] = [];
    const offListener = appCheck.onTokenChanged(handle, (result) => listener.push(result.token));
    const offObserver = appCheck.onTokenChanged(handle, { next: (result) => observer.push(result.token), error: () => {} });
    const counts: number[] = [];
    await appCheck.getToken(handle);
    await sleep(300);
    counts.push(listener.length);
    await appCheck.getToken(handle);
    await sleep(300);
    counts.push(listener.length);
    await appCheck.getToken(handle, true);
    await sleep(300);
    counts.push(listener.length);
    await appCheck.getLimitedUseToken(handle);
    await appCheck.getLimitedUseToken(handle);
    await appCheck.getToken(handle);
    await sleep(300);
    counts.push(listener.length);
    offListener();
    offObserver();
    await appCheck.getToken(handle, true);
    await sleep(300);
    counts.push(listener.length);
    // Divergence, by design (row app-check#on-token-changed-refresh). Production
    // in debug mode never calls listeners registered before the first token:
    expect([
      o.listenerCallsAfterFirstGet,
      o.listenerCallsAfterTwoGets,
      o.listenerCallsAfterForceRefresh,
      o.listenerCallsAfterLimitedUse,
      o.listenerCallsAfterUnsubscribeAndForce,
      o.observerCallsTotal,
    ]).toEqual([0, 0, 0, 0, 0, 0]);
    // The sandbox follows the documented provider path: one call per cached
    // token change, none for limited-use tokens, none after unsubscribing.
    expect(counts).toEqual([1, 1, 2, 2, 2]);
    expect(observer.length).toBe(2);
  },

  'app-check#set-auto-refresh': async () => {
    const o = obs('app-check-client-auto-refresh-toggle');
    const handle = appCheck.initializeAppCheck(freshApp('toggle'), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const cached = await appCheck.getToken(handle);
    const off = appCheck.setTokenAutoRefreshEnabled(handle, false);
    const on = appCheck.setTokenAutoRefreshEnabled(handle, true);
    appCheck.setTokenAutoRefreshEnabled(handle, false);
    const after = await appCheck.getToken(handle);
    expect({ offThrew: false, offReturn: String(off), onThrew: false, onReturn: String(on) }).toEqual({
      offThrew: o.offThrew,
      offReturn: o.offReturn,
      onThrew: o.onThrew,
      onReturn: o.onReturn,
    });
    expect(after.token === cached.token).toBe(o.getTokenAfterToggleReturnsCached);
  },

  'app-check#exchange-debug-token-wire': async () => {
    const o = obs('app-check-exchange-debug-token-wire');
    // The sandbox serves no exchange endpoint; the in-process token must still
    // carry the TTL the exchange reports.
    const handle = appCheck.initializeAppCheck(freshApp('wire'), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const { token } = await appCheck.getToken(handle);
    expect(`${jwtShape(token, SECRETS).ttlSeconds}s`).toBe(o.registered.ttl);
    expect(o.unregistered.httpStatus).toBe(403);
    const sandboxEndpoint = (appCheck as Record<string, unknown>).exchangeDebugToken;
    expect(sandboxEndpoint).toBeDefined();
  },
};

describe('concurrent getToken listener calls (unit)', () => {
  // Production in debug mode never notifies listeners from getToken (row
  // app-check#on-token-changed-refresh, by design). The sandbox follows the
  // provider path: one notification per shared exchange.
  it('notifies a listener once per shared exchange', async () => {
    const handle = appCheck.initializeAppCheck(freshApp('concurrent-listener'), { provider: provider(), isTokenAutoRefreshEnabled: false });
    const seen: string[] = [];
    const unsubscribe = appCheck.onTokenChanged(handle, (result) => seen.push(result.token));
    const [first] = await Promise.all([appCheck.getToken(handle), appCheck.getToken(handle)]);
    await sleep(50);
    expect(seen).toEqual([first.token]);
    const [forced] = await Promise.all([appCheck.getToken(handle, true), appCheck.getToken(handle, true)]);
    await sleep(50);
    unsubscribe();
    expect(seen).toEqual([first.token, forced.token]);
  });
});

describe('initializeAppCheck auto-refresh and automaticDataCollectionEnabled (unit)', () => {
  const BLOCKED_WARNING =
    '`isTokenAutoRefreshEnabled` is true but `automaticDataCollectionEnabled` was set to false during `initializeApp()`. This blocks automatic token refresh.';

  function warningsDuring(operation: () => void): unknown[][] {
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      operation();
    } finally {
      console.warn = original;
    }
    return calls;
  }

  it('warns when automaticDataCollectionEnabled: false blocks an explicit true', () => {
    const app = initializeApp(OPTIONS, { name: 'blocked-refresh', automaticDataCollectionEnabled: false });
    const calls = warningsDuring(() => appCheck.initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: true }));
    expect(calls.map((args) => args.join(' '))).toEqual([BLOCKED_WARNING]);
  });

  it('does not warn when auto-refresh is unset, false, or allowed', () => {
    const blocked = { automaticDataCollectionEnabled: false };
    const cases = [
      { settings: blocked, refresh: undefined },
      { settings: blocked, refresh: false },
      { settings: { automaticDataCollectionEnabled: true }, refresh: true },
    ];
    for (const [index, { settings, refresh }] of cases.entries()) {
      const app = initializeApp(OPTIONS, { name: `quiet-refresh-${index}`, ...settings });
      expect(warningsDuring(() => appCheck.initializeAppCheck(app, { provider: provider(), isTokenAutoRefreshEnabled: refresh }))).toEqual([]);
    }
  });
});

const isExpectedGreen = (status: string) => status === 'conforms' || status === 'diverged-documented';
const clientRows = appCheckRows.filter((row) => row.surface === 'app-check');

describe('oracle conformance (app-check client)', () => {
  for (const row of clientRows) {
    const register = isExpectedGreen(row.status) || isClimb ? it : it.skip;
    register(`${row.id} ${row.api}`, async () => {
      const assertion = assertions[row.id];
      if (!assertion) throw new Error(`no assertion set authored for ${row.id}`);
      await assertion();
    });
  }

  it('completeness: one assertion set per app-check client row (partition gate)', () => {
    expect(Object.keys(assertions).sort()).toEqual(clientRows.map((row) => row.id).sort());
    const surfaces = new Set(appCheckRows.map((row) => row.surface));
    expect([...surfaces].sort()).toEqual(['app-check', 'app-check-admin']);
  });

  (isClimb ? it : it.skip)('completeness: every observations/app-check/ capture is asserted (prefix gate)', () => {
    const report = gate.report();
    expect(report.committed.length).toBe(12);
    expect(report.loadedButUnused).toEqual([]);
    expect(report.uncovered).toEqual([]);
  });
});
