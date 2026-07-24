/**
 * `@pyric/cli/next` — the dev-only Next.js configuration wrapper (`withPyric`)
 * that configures module aliasing for Webpack & Turbopack, externalizes server
 * SDKs for Node runtime loader interception, and establishes dev-time rewrites
 * for Pyric sandbox socket & bridge communication.
 *
 *   import { withPyric } from '@pyric/cli/next';
 *   export default withPyric({ /* your next config * / });
 */
export { withPyric } from './with-pyric.js';
export type {
  PyricNextOptions,
  NextConfig,
  NextConfigObject,
  NextConfigFunction,
} from './types.js';
