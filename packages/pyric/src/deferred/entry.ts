/**
 * The shared factory behind pyric's *deferred* Firebase Web SDK subpaths —
 * `pyric/functions`, `pyric/analytics`, `pyric/app-check`,
 * `pyric/firestore/lite`, `pyric/performance` and `pyric/remote-config`.
 *
 * WHY THESE EXIST AT ALL. pyric is a symbol-for-symbol drop-in for the
 * Firebase Web SDK: an app swaps the `firebase` specifier for `pyric` and its
 * module graph must keep loading. A subpath that is simply absent from the
 * package `exports` map fails at RESOLVE time — Node raises
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, bundlers raise their own variants — long
 * before any pyric code runs. That error names neither pyric nor the reason,
 * so a developer whose app merely *mentions* `firebase/functions` on a code
 * path it never takes sees an unattributable build failure.
 *
 * THE CONTRACT. Resolution and linking succeed; *use* fails loudly.
 *   - The subpath resolves, so the module graph loads.
 *   - Every symbol the real Firebase entry exports is present as a value, so
 *     named-import linking (which is static in ESM — a missing name is a link
 *     error, not a runtime one) succeeds and bundlers can tree-shake.
 *   - Calling, constructing, or reading a member off one of those values
 *     throws {@link PyricDeferredApiError} with a message that names the
 *     subpath and points at the conformance matrix.
 *
 * An app that imports but never calls therefore runs unchanged. An app that
 * genuinely depends on a deferred service gets one clear, attributed error at
 * the exact call site instead of a cryptic resolver failure.
 *
 * NOT a mirror. These entries deliberately implement nothing. They are marked
 * deferred in the conformance surface story and must never be counted as
 * implemented surface.
 */

/**
 * Compose the single user-facing message every deferred entry raises.
 *
 * @param subpath - The Firebase subpath *without* the `firebase/` prefix, e.g.
 *   `functions` or `firestore/lite`.
 */
function deferredApiMessage(subpath: string): string {
  return (
    `pyric: 'firebase/${subpath}' is not yet mirrored by the local sandbox. ` +
    'This API is deferred — see the conformance matrix. Imports resolve so ' +
    'module graphs load; calls fail with this message.'
  );
}

/**
 * The error thrown by every deferred Firebase entry. Carries the subpath and
 * the symbol that was touched so tooling can group these without parsing the
 * message.
 */
export class PyricDeferredApiError extends Error {
  override readonly name = 'PyricDeferredApiError';

  /** The Firebase subpath, without the `firebase/` prefix (e.g. `functions`). */
  readonly subpath: string;

  /** The exported symbol whose use triggered this error (e.g. `getFunctions`). */
  readonly symbol: string;

  constructor(subpath: string, symbol: string) {
    super(deferredApiMessage(subpath));
    this.subpath = subpath;
    this.symbol = symbol;
  }
}

/**
 * The static type of a deferred export.
 *
 * It is callable, constructible, and indexable so a deferred symbol can stand
 * in for any of the three shapes a Firebase entry exports — a factory function
 * (`getFunctions`), a class (`ReCaptchaV3Provider`), or an enum-like constant
 * object (`HarmCategory`). Every result is `never`, which is assignable to
 * anything, so a consumer's own annotations keep type-checking.
 */
export interface DeferredApi {
  (...args: readonly unknown[]): never;
  new (...args: readonly unknown[]): never;
  readonly [member: string]: never;
}

/**
 * Property reads that must NOT throw.
 *
 * Bundlers, test runners, `console.log`, promise adoption and React all probe
 * values with these keys as part of ordinary machinery, never as an intent to
 * use the API. Throwing on `then` in particular would turn `await`-ing
 * anything holding a deferred value into this error at the wrong site, and
 * throwing on `$$typeof` would break React's element check. They read as
 * `undefined`, exactly as they would on a real function.
 */
const INERT_PROPERTIES: ReadonlySet<string> = new Set([
  '$$typeof',
  '__esModule',
  'constructor',
  'displayName',
  'inspect',
  'length',
  'name',
  'nodeType',
  'prototype',
  'then',
  'toJSON',
  'toString',
  'valueOf',
]);

/**
 * Build one deferred export: a function that throws when called or
 * constructed, wrapped in a proxy so member reads (the enum-constant shape)
 * throw the same error.
 */
function deferredSymbol(subpath: string, symbol: string): DeferredApi {
  const throwing = function deferred(): never {
    throw new PyricDeferredApiError(subpath, symbol);
  };
  Object.defineProperty(throwing, 'name', { value: symbol, configurable: true });

  return new Proxy(throwing, {
    get(target, property, receiver) {
      // Symbol-keyed reads are always machinery (Symbol.toPrimitive,
      // Symbol.hasInstance, Symbol.toStringTag, the inspect hook, …) — never a
      // user reaching for an API member.
      if (typeof property === 'symbol' || INERT_PROPERTIES.has(property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new PyricDeferredApiError(subpath, `${symbol}.${property}`);
    },
    construct() {
      throw new PyricDeferredApiError(subpath, symbol);
    },
  }) as unknown as DeferredApi;
}

/**
 * The lazily-materialised export bag for one deferred subpath.
 *
 * Each entry module destructures the symbols it needs off this object:
 *
 * ```ts
 * export const { getFunctions, httpsCallable } = deferredEntry('functions');
 * ```
 *
 * Destructuring is what makes the names real ESM exports (and what keeps the
 * generated `.d.ts` honest); the proxy just mints a correctly-attributed stub
 * for whichever name is read.
 *
 * @param subpath - The Firebase subpath, without the `firebase/` prefix.
 */
export function deferredEntry(subpath: string): Record<string, DeferredApi> {
  const minted = new Map<string, DeferredApi>();
  return new Proxy(Object.create(null) as Record<string, DeferredApi>, {
    get(_target, property) {
      if (typeof property === 'symbol') return undefined as unknown as DeferredApi;
      let api = minted.get(property);
      if (!api) {
        api = deferredSymbol(subpath, property);
        minted.set(property, api);
      }
      return api;
    },
    has() {
      return true;
    },
  });
}
