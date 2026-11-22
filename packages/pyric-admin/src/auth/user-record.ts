/**
 * `firebase-admin/auth` `UserRecord` runtime class (`lib/auth/user-record.js`, v13.10.0).
 */
import { parseClaimJson, stringifyClaimJson } from 'pyric/sandbox/internal';
import type { UserRecordInit } from './types.js';
import type { UserInfo } from './user-info.js';
import type { UserMetadata } from './user-metadata.js';

export class UserRecord {
  readonly uid: string;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly displayName?: string;
  readonly photoURL?: string;
  readonly phoneNumber?: string;
  readonly disabled: boolean;
  readonly metadata: UserMetadata;
  readonly providerData: UserInfo[];
  readonly customClaims?: Record<string, unknown>;
  readonly tokensValidAfterTime?: string;
  readonly tenantId: string | null;

  constructor(init: UserRecordInit) {
    this.uid = init.uid;
    this.email = init.email;
    this.emailVerified = init.emailVerified;
    this.displayName = init.displayName;
    this.photoURL = init.photoURL;
    this.phoneNumber = init.phoneNumber;
    this.disabled = init.disabled;
    this.metadata = init.metadata;
    this.providerData = init.providerData;
    this.customClaims = init.customClaims;
    this.tokensValidAfterTime = init.tokensValidAfterTime;
    this.tenantId = init.tenantId;
  }

  toJSON(): Record<string, unknown> {
    let clonedClaims: Record<string, unknown> | undefined;
    if (this.customClaims !== undefined) {
      clonedClaims = parseClaimJson(stringifyClaimJson(this.customClaims)) as Record<string, unknown>;
    }
    return {
      uid: this.uid,
      email: this.email,
      emailVerified: this.emailVerified,
      displayName: this.displayName,
      photoURL: this.photoURL,
      phoneNumber: this.phoneNumber,
      disabled: this.disabled,
      metadata: this.metadata.toJSON(),
      customClaims: clonedClaims,
      tokensValidAfterTime: this.tokensValidAfterTime,
      tenantId: this.tenantId,
      providerData: this.providerData.map((entry) => entry.toJSON()),
    };
  }
}
