/**
 * The page plane's parts that run without a browser: the records a page
 * sends to the host, the modules it serves for the live rows, and the
 * refusal of every other served specifier. `test/e2e` drives them in a page.
 */
import { describe, expect, test } from 'bun:test';
import { OBSERVER_MODULE_ID, ROW_MODULE_IDS, SDK_MODULES, type ObservedCall, type ServedFirebaseSpecifier } from '@pyric/cli/vite/internal/supplied-rows';
import { LIVE_MODULES, LIVE_ROWS, type LiveCallRecord } from '../src/index.js';
import { observedCallOf, pageObserver } from '../src/page-observer.js';
import { liveModuleSource } from '../src/page-modules.js';

const rowId = (specifier: ServedFirebaseSpecifier): string => ROW_MODULE_IDS.get(specifier) ?? `\0pyric-live:${specifier}`;
import { LIVE_REFUSED, liveRefusal } from '../src/refusal.js';

const AT = 1_762_000_000_000;

describe('the records a page sends to the host', () => {
  test("carry production's answer for each Firestore and Auth outcome", () => {
    const record = (outcome: LiveCallRecord['outcome'], code?: string): LiveCallRecord =>
      ({ module: 'firebase/firestore', name: 'getDoc', outcome, ...(code === undefined ? {} : { code }) });
    expect(observedCallOf(record('resolved'), AT)).toEqual({ service: 'firestore', method: 'getDoc', at: AT, outcome: { status: 'ok' } });
    expect(observedCallOf(record('delivered'), AT)?.outcome).toEqual({ status: 'ok' });
    expect(observedCallOf(record('rejected', 'permission-denied'), AT)?.outcome).toEqual({ status: 'error', code: 'permission-denied' });
    expect(observedCallOf(record('listener-error', 'unavailable'), AT)?.outcome).toEqual({ status: 'error', code: 'unavailable' });
    expect(observedCallOf(record('threw', 'invalid-argument'), AT)?.outcome).toEqual({ status: 'error', code: 'invalid-argument' });
    const auth: LiveCallRecord = { module: 'firebase/auth', name: 'signInAnonymously', outcome: 'rejected', code: 'auth/network-request-failed' };
    expect(observedCallOf(auth, AT)).toEqual({
      service: 'auth', method: 'signInAnonymously', at: AT, outcome: { status: 'error', code: 'auth/network-request-failed' },
    });
  });

  test('leave out a synchronous return, and every firebase/app and firebase/app-check record', () => {
    expect(observedCallOf({ module: 'firebase/firestore', name: 'onSnapshot', outcome: 'returned' }, AT)).toBeNull();
    expect(observedCallOf({ module: 'firebase/app', name: 'initializeApp', outcome: 'returned' }, AT)).toBeNull();
    expect(observedCallOf({ module: 'firebase/app-check', name: 'getToken', outcome: 'resolved' }, AT)).toBeNull();
  });

  test('are sent once each, with the time they were made', async () => {
    const sent: ObservedCall[] = [];
    const observer = pageObserver(async (call) => { sent.push(call); }, () => AT);
    await observer({ module: 'firebase/auth', name: 'signOut', outcome: 'resolved' });
    expect(observer({ module: 'firebase/app', name: 'getApp', outcome: 'returned' })).toBeUndefined();
    expect(sent).toEqual([{ service: 'auth', method: 'signOut', at: AT, outcome: { status: 'ok' } }]);
  });
});

describe('the modules a page gets for the live rows', () => {
  test("import the installed module, re-export all of it, and export each observed name from the row's wrapper", () => {
    for (const [specifier, key] of LIVE_ROWS) {
      const source = liveModuleSource(rowId(specifier), '/cli/observed-call-sender.js') as string;
      const quoted = JSON.stringify(specifier);
      expect(source).toContain(`import * as __pyricReal from ${quoted};`);
      expect(source).toContain(`export * from ${quoted};`);
      expect(source).toContain(`liveModuleFor(${quoted}, __pyricReal, observer, SDK_VERSION)`);
      const spec = LIVE_MODULES[key];
      for (const name of [...spec.calls, ...spec.listeners]) {
        expect(source).toContain(`export const ${name} = __pyricLive.${name};`);
      }
    }
  });

  test('share one observer that sends through the sender beside the page runtime', () => {
    const source = liveModuleSource(OBSERVER_MODULE_ID, '/cli/dist/serve/entries/observed-call-sender.js') as string;
    expect(source).toContain('import { sendObservedCall } from "/@fs/cli/dist/serve/entries/observed-call-sender.js";');
    expect(source).toContain('pageObserver(sendObservedCall)');
  });

  test('exist only for the four rows', () => {
    expect(liveModuleSource(rowId('firebase/storage'), '/sender.js')).toBeNull();
    expect(liveModuleSource('/src/main.ts', '/sender.js')).toBeNull();
  });
});

describe('the refusal of a served specifier with no live row', () => {
  test('names live mode and the service, for every such specifier', () => {
    const refused = SDK_MODULES.filter((specifier) => !LIVE_ROWS.has(specifier));
    for (const specifier of refused) {
      const error = liveRefusal(specifier, 'page') as Error & { code?: string };
      expect(error.code).toBe(LIVE_REFUSED);
      expect(error.message).toContain(`${specifier} (`);
      expect(error.message).toContain('refused in live mode');
      expect(error.message).toContain('not served from the Pyric sandbox');
    }
    expect(liveRefusal('firebase/storage', 'page').message).toContain('(Cloud Storage)');
    expect(liveRefusal('firebase-admin/app', 'server').message).toContain('(the Admin SDK)');
    expect(liveRefusal('firebase-admin/app', 'server').message).toContain('server code the dev server runs');
  });
});
