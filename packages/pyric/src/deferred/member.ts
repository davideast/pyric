/**
 * Deferred members: single methods of a mirrored class that the sandbox does
 * not model.
 *
 * A deferred *entry* (see `entry.ts`) stands in for a whole subpath. A
 * deferred *member* stands in for one method on an object the sandbox does
 * mirror, such as `File.copy` on a `pyric-admin/storage` file handle. Without
 * it the method reads as `undefined` and the call site fails with
 * "is not a function", which names neither pyric nor the method. With it the
 * call throws, or rejects for a method whose upstream form returns a
 * promise, a {@link PyricDeferredApiError} that names the method.
 *
 * Every deferred member and every deferred entry export carries the
 * {@link DEFERRED_API} brand, so a surface check can tell a not-implemented
 * stub apart from an implemented method without calling it.
 */
import { DEFERRED_API, deferredSymbol, PyricDeferredApiError, type DeferredApi } from './entry.js';

/** How a deferred member fails: by throwing, or by returning a rejected promise. */
export type DeferredMemberKind = 'sync' | 'async';

/**
 * The method names one mirrored class leaves unimplemented, split by how each
 * fails. `async` lists the methods whose upstream form returns a promise.
 */
export interface DeferredMembers {
  readonly sync?: readonly string[];
  readonly async?: readonly string[];
}

/** The message a deferred member or export of a mirrored subpath raises. */
function deferredMemberMessage(subpath: string, symbol: string): string {
  return (
    `${subpath}: ${symbol} is not implemented in ${subpath} sandbox backend. ` +
    'The sandbox does not model this API; calls fail with this message.'
  );
}

/**
 * Build one deferred export of a mirrored subpath, for a value the subpath
 * does not model: a class (`GeoPoint`), a namespace object (`Filter`) or an
 * enum (`GrpcStatus`). Calling it, constructing it or reading a member off it
 * throws a {@link PyricDeferredApiError} naming it.
 *
 * @param subpath - The package subpath, e.g. `pyric-admin/firestore`.
 * @param symbol - The export name.
 */
export function deferredExport(subpath: string, symbol: string): DeferredApi {
  return deferredSymbol(subpath, symbol, deferredMemberMessage(subpath, symbol));
}

/**
 * Build one deferred method.
 *
 * @param subpath - The package subpath the owning class belongs to, with its
 *   package prefix, e.g. `pyric-admin/storage`.
 * @param symbol - The member, qualified by its class, e.g. `File.copy`.
 * @param kind - `async` returns a rejected promise; `sync` throws.
 */
export function deferredMember(
  subpath: string,
  symbol: string,
  kind: DeferredMemberKind,
): (...args: unknown[]) => never | Promise<never> {
  const message = deferredMemberMessage(subpath, symbol);
  const method =
    kind === 'async'
      ? function deferred(): Promise<never> {
          return Promise.reject(new PyricDeferredApiError(subpath, symbol, message));
        }
      : function deferred(): never {
          throw new PyricDeferredApiError(subpath, symbol, message);
        };
  Object.defineProperty(method, 'name', { value: symbol.slice(symbol.lastIndexOf('.') + 1), configurable: true });
  Object.defineProperty(method, DEFERRED_API, { value: true });
  return method;
}

/**
 * Define a deferred method on `target` for every listed name the target does
 * not already provide. A name the target implements, directly or through its
 * prototype chain, is left alone.
 *
 * @param target - Usually a class prototype.
 * @param subpath - See {@link deferredMember}.
 * @param owner - The upstream class name, e.g. `File`.
 * @param members - The unimplemented method names.
 */
export function defineDeferredMembers(
  target: object,
  subpath: string,
  owner: string,
  members: DeferredMembers,
): void {
  for (const kind of ['sync', 'async'] as const) {
    for (const name of members[kind] ?? []) {
      if (name in target) continue;
      Object.defineProperty(target, name, {
        value: deferredMember(subpath, `${owner}.${name}`, kind),
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  }
}
