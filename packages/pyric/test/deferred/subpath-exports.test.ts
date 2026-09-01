/**
 * Resolve-time guard for the Firebase Web SDK subpaths pyric does not mirror
 * yet.
 *
 * The drop-in promise is symbol-for-symbol: an app that swaps `firebase` for
 * `pyric` must keep loading even when it touches a service the sandbox has not
 * implemented. Before these entries existed, `import 'firebase/functions'`
 * under the swap died at RESOLVE time with `ERR_PACKAGE_PATH_NOT_EXPORTED` —
 * an error with no attribution to pyric and no hint about what to do.
 *
 * The contract these tests freeze:
 *   - the subpath RESOLVES and the module graph loads (import never throws);
 *   - every documented value export is present, so named-import linking and
 *     bundler tree-shaking succeed;
 *   - USING one (call, construct, or property read) throws a single, clearly
 *     attributed pyric error.
 */
import { describe, expect, test } from 'bun:test';

/** Subpath → representative exports that must exist on the namespace. */
const DEFERRED_SUBPATHS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['firestore/lite', ['getFirestore', 'collection', 'getDocs', 'writeBatch', 'Timestamp']],
  ['app-check', ['initializeAppCheck', 'ReCaptchaV3Provider', 'getToken']],
  ['functions', ['getFunctions', 'httpsCallable', 'connectFunctionsEmulator']],
  ['analytics', ['getAnalytics', 'logEvent', 'setUserId']],
  ['performance', ['getPerformance', 'trace']],
  ['remote-config', ['getRemoteConfig', 'fetchAndActivate', 'getValue']],
];

/** The exact user-facing message every deferred entry raises. */
function deferredMessage(subpath: string): string {
  return (
    `pyric: 'firebase/${subpath}' is not yet mirrored by the local sandbox. ` +
    'This API is deferred — see the conformance matrix. Imports resolve so ' +
    'module graphs load; calls fail with this message.'
  );
}

/**
 * Subpaths whose value surface can be diffed against the installed Firebase
 * Web SDK. (`firebase/vertexai` was removed in v12 — renamed to `firebase/ai`,
 * which pyric already mirrors — so pyric ships no `./vertexai` entry either:
 * resolving it fails exactly as it does on the real SDK.)
 */
const DIFFABLE_SUBPATHS: readonly string[] = [
  'firestore/lite',
  'app-check',
  'functions',
  'analytics',
  'performance',
  'remote-config',
];

describe('deferred entries mirror the real Firebase value surface exactly', () => {
  for (const subpath of DIFFABLE_SUBPATHS) {
    // A named import that Firebase exports but pyric does not is an ESM LINK
    // error — the app fails to load, which is the failure mode these entries
    // exist to prevent. An extra name pyric invents is a lie about the mirror.
    // Both directions matter, so compare the sorted sets.
    test(`pyric/${subpath}`, async () => {
      const mirror = (await import(`pyric/${subpath}`)) as Record<string, unknown>;
      const upstream = (await import(`firebase/${subpath}`)) as Record<string, unknown>;
      const mirrored = Object.keys(mirror)
        .filter((name) => name !== 'PyricDeferredApiError')
        .sort();
      expect(mirrored).toEqual(Object.keys(upstream).sort());
    });
  }
});

describe('deferred firebase subpaths resolve but throw on use', () => {
  for (const [subpath, symbols] of DEFERRED_SUBPATHS) {
    const first = symbols[0]!;

    describe(`pyric/${subpath}`, () => {
      test('resolves through the package exports map', async () => {
        const mod = await import(`pyric/${subpath}`);
        expect(typeof mod).toBe('object');
      });

      test('exposes its documented value exports', async () => {
        const mod = (await import(`pyric/${subpath}`)) as Record<string, unknown>;
        for (const symbol of symbols) {
          expect(typeof mod[symbol]).toBe('function');
        }
      });

      test('throws an attributed pyric error when called', async () => {
        const mod = (await import(`pyric/${subpath}`)) as Record<string, unknown>;
        const call = mod[first] as (...args: unknown[]) => unknown;
        expect(() => call()).toThrow(deferredMessage(subpath));
      });

      test('throws when constructed', async () => {
        const mod = (await import(`pyric/${subpath}`)) as Record<string, unknown>;
        const ctor = mod[first] as new (...args: unknown[]) => unknown;
        expect(() => new ctor()).toThrow(deferredMessage(subpath));
      });

      test('throws when an enum-style member is read', async () => {
        const mod = (await import(`pyric/${subpath}`)) as Record<string, unknown>;
        const value = mod[first] as Record<string, unknown>;
        expect(() => value.SOME_ENUM_MEMBER).toThrow(deferredMessage(subpath));
      });
    });
  }
});

describe('isSupported guards resolve instead of throwing', () => {
  // The standard Firebase pattern `isSupported().then(ok => ok && getX(app))`
  // must not crash at the guard itself: the real SDK resolves a boolean, and a
  // deferred entry IS unsupported, so the honest answer is `false`.
  for (const subpath of ['analytics', 'remote-config'] as const) {
    test(`pyric/${subpath} isSupported() resolves false`, async () => {
      const mod = (await import(`pyric/${subpath}`)) as {
        isSupported: () => Promise<boolean>;
      };
      await expect(mod.isSupported()).resolves.toBe(false);
    });
  }
});
