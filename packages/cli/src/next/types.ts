/**
 * Public configuration types for the `@pyric/cli/next` integration.
 */

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
   * or `PYRIC_SANDBOX_PORT`, falling back to `4000`.
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
}

export type NextConfigObject = Record<string, any>;

export type NextConfigFunction = (
  phase: string,
  defaults: Record<string, any>,
) => NextConfigObject | Promise<NextConfigObject>;

export type NextConfig = NextConfigObject | NextConfigFunction;
