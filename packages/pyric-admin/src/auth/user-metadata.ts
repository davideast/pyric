/**
 * `firebase-admin/auth` `UserMetadata` runtime class (`lib/auth/user-record.js`, v13.10.0).
 */
import type { UserMetadataInit } from './types.js';

export class UserMetadata {
  readonly creationTime: string;
  readonly lastSignInTime: string;
  readonly lastRefreshTime?: string | null;

  constructor(init: UserMetadataInit) {
    this.creationTime = init.creationTime;
    this.lastSignInTime = init.lastSignInTime;
    if (init.lastRefreshTime !== undefined) {
      this.lastRefreshTime = init.lastRefreshTime;
    }
  }

  toJSON(): Record<string, unknown> {
    const json: Record<string, unknown> = {
      creationTime: this.creationTime,
      lastSignInTime: this.lastSignInTime,
    };
    if (this.lastRefreshTime !== undefined) {
      json.lastRefreshTime = this.lastRefreshTime;
    }
    return json;
  }
}
