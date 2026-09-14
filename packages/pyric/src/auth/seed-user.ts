/** Seed record shared by account import and persistence validation. */
export interface SeedUser {
  uid: string;
  /** Account timestamps retained by export, checkpoints, and host restart. */
  createdAt?: string;
  lastLoginAt?: string | null;
  /** Absent for an anonymous account (`providerId: 'anonymous'`), which has
   *  no address to sign in with. Required for every other provider. */
  email?: string;
  /** Absent for an anonymous account. Required for every other provider;
   *  a provider-flow identity with no password uses
   *  {@link NO_PASSWORD_SENTINEL} instead of omitting it. */
  password?: string;
  displayName?: string;
  customClaims?: Record<string, unknown>;
  /** Profile photo URL, mirroring the stored record's `photoUrl`.
   *  Omitted for records that carry none. */
  photoUrl?: string;
  /** Phone number on the record. Omitted for records that carry none. */
  phoneNumber?: string;
  /** Whether the address on the record is verified. Omitted when false
   *  — the seeded default. */
  emailVerified?: boolean;
  /** Whether the account rejects every sign-in with
   *  `auth/user-disabled`. Omitted when false — the seeded default. */
  disabled?: boolean;
  /** Identity Platform tenant the record belongs to. Omitted for
   *  untenanted identities. Absent is the seeded default. */
  tenantId?: string;
  /** Originating provider for this identity (e.g. `'google.com'`).
   *  Defaults to `'password'` — the natural provider for a record
   *  seeded with an email + password. A host seeding popup-flow
   *  identities passes the real provider so `listIdentities` /
   *  `IdTokenResult.signInProvider` label them correctly. */
  providerId?: string;
}
