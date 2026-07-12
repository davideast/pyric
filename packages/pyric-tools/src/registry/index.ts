/**
 * Prod/admin tool-registry composition for @pyric/cli. Composes the
 * per-domain factories (deploy / rules / firestore / discover / rtdb) into a
 * registry, and bootstraps the admin inputs from a service account.
 *
 * Consumers: the bridge's prod mode (`startServer({ prodTools })`), the
 * project-audit skill, and firestore-path discovery against a real project.
 */
export {
  composeMcpRegistry,
  type AdminAppDeps,
  type ComposeOptions,
  type Profile,
} from './compose.js';
export { adminDepsFromServiceAccount, type AdminDepsResult } from './admin-deps.js';
