/**
 * OAuth scope policy. The free path (rules / hosting / indexes) lives on the
 * narrow `firebase` + `datastore` scopes; only the PAID, rarely-used targets
 * (functions / storage) need `cloud-platform`, so they lazy-upgrade.
 *
 * (Confirm the narrow strings against each API's discovery doc; `cloudfunctions`
 * and `serviceusage.enable` are the ones with no narrower scope than
 * cloud-platform, which is exactly why they're the lazy tier.)
 */
export const SCOPES = {
  openid: 'openid',
  email: 'email',
  firebase: 'https://www.googleapis.com/auth/firebase',
  firebaseDatabase: 'https://www.googleapis.com/auth/firebase.database',
  datastore: 'https://www.googleapis.com/auth/datastore',
  cloudPlatform: 'https://www.googleapis.com/auth/cloud-platform',
} as const;

/** The scopes a base `pyric login` requests — the whole free deploy path. */
export const BASE_SCOPES: readonly string[] = [SCOPES.openid, SCOPES.email, SCOPES.firebase, SCOPES.datastore];

/**
 * Is `required` covered by what was `granted`? Returns the missing scope (so the
 * caller can name it in an upgrade prompt) or `null` when already covered.
 * `cloud-platform` is a superset — granting it covers the narrower scopes too.
 */
export function missingScope(granted: readonly string[], required: string): string | null {
  if (granted.includes(required)) return null;
  if (granted.includes(SCOPES.cloudPlatform)) return null; // cloud-platform subsumes the narrow ones
  return required;
}
