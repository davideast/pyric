/**
 * `firebase-admin/auth` `UserInfo` runtime class (`lib/auth/user-record.js`, v13.10.0).
 */
import type { UserInfoInit } from './types.js';

export class UserInfo {
  readonly providerId: string;
  readonly uid: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;

  constructor(init: UserInfoInit) {
    this.providerId = init.providerId;
    this.uid = init.uid;
    this.displayName = init.displayName;
    this.email = init.email;
    this.photoURL = init.photoURL;
    this.phoneNumber = init.phoneNumber;
  }

  toJSON(): Record<string, unknown> {
    return {
      uid: this.uid,
      displayName: this.displayName,
      email: this.email,
      photoURL: this.photoURL,
      providerId: this.providerId,
      phoneNumber: this.phoneNumber,
    };
  }
}
