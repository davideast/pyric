/**
 * Public configuration types for the `@pyric/cli/next` integration.
 */

import type { PyricRuntimeChipOption } from '../serve/runtime/chip-config.js';
export type { PyricRuntimeChipOption };

export interface PyricNextFunctionsOptions {
  /**
   * Explicit URL override for the local Pyric Functions HTTP gateway
   * (for example `http://127.0.0.1:4000`). Must name a loopback or
   * private-network origin; public origins are rejected.
   */
  url?: string;
  /**
   * Port override on loopback (`http://127.0.0.1:<port>`) for the local
   * Pyric Functions HTTP gateway.
   */
  port?: number;
  /**
   * Directory searched for `firebase.json`, `.firebaserc`, and `pyric.json`
   * when resolving Functions discovery, Hosting function rewrites, and
   * Firebase project ID. Defaults to `process.cwd()`.
   */
  projectDir?: string;
  /**
   * Whether to proxy `firebase.json` `hosting.rewrites` whose target is a
   * Cloud Function to the local Functions gateway. Default `true`.
   */
  hostingRewrites?: boolean;
  /**
   * Explicit Firebase project ID used for emulator-path callable/HTTP
   * rewrites (`/<projectId>/<region>/<name>`). Resolved automatically from
   * `PYRIC_PROJECT`, `pyric.json`, `.firebaserc`, or `firebase-tools` when
   * omitted.
   */
  projectId?: string;
}

export interface PyricNextOptions {
  /**
   * Guard against starting Next.js dev server directly (`next dev`) without
   * active Pyric sandbox environment variables. When `true` (default), throws
   * an early error if `PYRIC_SANDBOX` is missing during development builds.
   * Pass `false` to opt out of safety checking.
   */
  guard?: boolean;
  /**
   * Port override for the local Pyric sandbox server when configuring dev-time
   * rewrites (`/__pyric/:path*`). By default, resolves from `PYRIC_SANDBOX`
   * (bare `remote` reads the project's `.pyric/serve.json`) or
   * `PYRIC_SANDBOX_PORT`, falling back to `4000`.
   */
  port?: number;
  /**
   * Explicit URL override for the local Pyric sandbox server when configuring
   * dev-time rewrites (e.g., `http://localhost:4000`).
   */
  url?: string;
  /**
   * Whether to configure Next.js dev-time rewrites to proxy `/__pyric/:path*`
   * traffic to the local Pyric dev server. Default `true`.
   */
  rewrites?: boolean;
  /**
   * Configure proxying to the local Pyric Functions HTTP gateway:
   * - `undefined` (default): automatically activates when `firebase.json` in
   *   the project has a discoverable Functions source (matching `pyric sandbox`),
   *   or when `PYRIC_FUNCTIONS_GATEWAY_URL` is set. Safely falls back to no
   *   Functions rewrites when no Functions gateway is active.
   * - `true`: explicitly enables Functions gateway rewrites (`/__pyric/functions/*`,
   *   `firebase.json` Hosting function rewrites, and emulator-path routing).
   * - `false`: disables all Functions gateway and Hosting function rewrites.
   * - `PyricNextFunctionsOptions`: enables and customizes Functions gateway routing.
   */
  functions?: boolean | PyricNextFunctionsOptions;
  /**
   * Display the floating Pyric runtime chip in browser client pages during
   * local development. On by default. Pass `false` to hide it, or
   * `{ initiallyOpen: true }` when actively debugging runtime errors.
   */
  runtimeChip?: PyricRuntimeChipOption;
}

export type NextConfigObject = Record<string, any>;

export type NextConfigFunction = (
  phase: string,
  defaults: Record<string, any>,
) => NextConfigObject | Promise<NextConfigObject>;

export type NextConfig = NextConfigObject | NextConfigFunction;
