/**
 * Build an `RtdbHost` from an `AgentApp`-shaped object.
 *
 * Used by `composeMcpRegistry` to bridge `AdminAppDeps.agentApp` to
 * `@pyric/rtdb`'s `RtdbHost` contract.
 *
 * Takes a structural shape — `AgentAppLike` — so `@pyric/rtdb` does not
 * couple to a specific app type; any future replacement (e.g. a
 * `ProjectContext`-based credential bundle) just needs to provide the
 * same four members.
 */

import type { RtdbHost } from './host.js';
import type { UserAuth } from './types.js';
import type { Database } from 'firebase/database';

/**
 * The structural app shape this helper needs. Defined structurally so
 * `@pyric/rtdb` doesn't couple to a specific app type.
 */
export interface AgentAppLike {
  readonly projectId: string;
  getRestToken(): Promise<string>;
  getUserToken(auth: UserAuth): Promise<string>;
  getClientDatabase(auth: UserAuth, databaseUrl: string): Promise<Database>;
}

export function initializeDatabaseApp(
  agentApp: AgentAppLike,
  options?: { databaseUrl?: string },
): RtdbHost {
  const databaseUrl =
    options?.databaseUrl ??
    `https://${agentApp.projectId}-default-rtdb.firebaseio.com`;
  return {
    projectId: agentApp.projectId,
    databaseUrl,
    resolveAdminToken: () => agentApp.getRestToken(),
    resolveUserToken: (auth) => agentApp.getUserToken(auth),
    getClientForUser: (auth) => agentApp.getClientDatabase(auth, databaseUrl),
  };
}
