/**
 * `@pyric/cli/vite/ssr-loader`: loads the module a server-rendered
 * `firebase/*` or `firebase-admin/*` import is routed to under `vite dev`
 * (#1123), through Node's own `import()` from this package.
 *
 * Vite runs a module a plugin resolves to a file inside its own runner, and
 * evaluates it again for each runner: the client SDK bootstrap, the app
 * registry and the host connection would each exist twice or three times in
 * one process. It loads a package the app root resolves through Node
 * instead, once per process. The plugin's shim for each routed import
 * imports this module, which the app root resolves since the app depends on
 * `@pyric/cli`, and loads the target from here, where `pyric`, `pyric-admin`
 * and this package's own subpaths resolve under any install layout.
 */

/** The targets the register mapping routes a server import to. Anything else is refused. */
const ROUTED_TARGET = /^(?:@pyric\/cli\/register\/client\/[a-z-]+|pyric(?:-admin)?(?:\/[a-z-]+)*)$/;

/** The routed module for `target`, as `mapFirebaseSpecifier` named it. */
export function loadServerTarget(target: string): Promise<Record<string, unknown>> {
  const isRoutedTarget = ROUTED_TARGET.test(target);
  if (!isRoutedTarget) return Promise.reject(new Error(`pyric: ${target} is not a routed server target`));
  return import(target) as Promise<Record<string, unknown>>;
}
