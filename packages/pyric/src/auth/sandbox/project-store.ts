/** Project-wide Auth data shared by app-local Auth session backends. */
import type { StoredUser } from '../sandbox-backend-types.js';

export interface AuthProjectStore {
  readonly usersByEmail: Map<string, StoredUser>;
  readonly usersByUid: Map<string, StoredUser>;
  readonly userDbSubscribers: Set<() => void>;
  readonly providerConfig: Map<string, boolean>;
  readonly providerConfigSubscribers: Set<() => void>;
  readonly counters: {
    nextAdminUserId: number;
  };
  /**
   * The project the minted ID tokens name in `iss` and `aud`, read at each
   * mint because a served host learns it after Auth starts. `undefined`
   * mints for `SANDBOX_PROJECT_ID`.
   */
  projectId: () => string | undefined;
}

export function createAuthProjectStore(): AuthProjectStore {
  return {
    usersByEmail: new Map(),
    usersByUid: new Map(),
    userDbSubscribers: new Set(),
    providerConfig: new Map([
      ['password', true],
      ['anonymous', true],
    ]),
    providerConfigSubscribers: new Set(),
    counters: {
      nextAdminUserId: 1,
    },
    projectId: () => undefined,
  };
}
