/**
 * Build an `RtdbHost` from an `AgentApp`-shaped object.
 *
 * Used by `composeMcpRegistry` to bridge `AdminAppDeps.agentApp` to
 * `pyric/database`'s `RtdbHost` contract.
 *
 * Takes a structural shape — `AgentAppLike` — so `pyric/database` does not
 * couple to a specific app type; any future replacement (e.g. a
 * `ProjectContext`-based credential bundle) just needs to provide the
 * same four members.
 */

import type { RtdbHost } from './host.js';
import type { RtdbDataTransport } from './data/transport.js';
import type { UserAuth } from './types.js';

/**
 * The structural app shape this helper needs. Defined structurally so
 * `pyric/database` doesn't couple to a specific app type.
 */
export interface AgentAppLike {
  readonly projectId: string;
  getRestToken(): Promise<string>;
  getUserToken(auth: UserAuth): Promise<string>;
  readonly data: RtdbDataTransport;
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
    data: agentApp.data,
    resolveAdminToken: () => agentApp.getRestToken(),
    resolveUserToken: (auth) => agentApp.getUserToken(auth),
  };
}
