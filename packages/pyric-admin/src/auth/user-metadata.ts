/**
 * `firebase-admin/auth` `UserMetadata` runtime class (`lib/auth/user-record.js`, v13.10.0).
 */
import type { UserMetadataInit } from './types.js';

export class UserMetadata {
  readonly creationTime: string;
  // Matches firebase-admin's UserMetadata declaration (`string`) while holding
  // `null` at runtime before the user's first sign-in (`lib/auth/user-record.js`).
  readonly lastSignInTime: string;
  readonly lastRefreshTime?: string | null;

  constructor(init: UserMetadataInit) {
    this.creationTime = init.creationTime;
    this.lastSignInTime = init.lastSignInTime as string;
    if (init.lastRefreshTime !== undefined) {
      this.lastRefreshTime = init.lastRefreshTime;
    } else {
      this.lastRefreshTime = null;
    }
  }

  toJSON(): Record<string, unknown> {
    let lastRefreshTime: string | null = null;
    if (this.lastRefreshTime !== undefined) {
      lastRefreshTime = this.lastRefreshTime;
    }
    return {
      lastSignInTime: this.lastSignInTime,
      creationTime: this.creationTime,
      lastRefreshTime,
    };
  }
}
