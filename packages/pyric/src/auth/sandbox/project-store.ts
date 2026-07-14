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
    nextAnonymousId: number;
  };
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
      nextAnonymousId: 1,
    },
  };
}
