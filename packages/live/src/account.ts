/**
 * The signed-in account a call ran as, read from the app's own Auth: the
 * account id, the names of its ID token's claims and their values, with the
 * account's emails left out. Never the token. The values go to the host
 * only, for its local rules' `request.auth.token`.
 *
 * The live Auth row notes each Auth instance `getAuth` and `initializeAuth`
 * hand the app, keyed by its app. A call's first argument names its app (a
 * reference's or query's `firestore.app`, a Firestore or Auth instance's
 * `app`, a user's `auth`), and that app's Auth holds the current user. The
 * user's `uid` is public. Its ID token is the `accessToken` the SDK keeps on
 * the user and refreshes in place; only the names in its payload are read.
 * A production token is signed and an Auth emulator token is not, but both
 * carry the same payload, so the claims read the same way from either.
 *
 * Reading never calls the app's code or the SDK's functions, and never
 * throws: an object that does not have these shapes names no account.
 */

import type { LiveAccount } from './observe.js';

/** The most claim names, and the longest name, a host accepts in one observed call. */
const MAX_CLAIM_NAMES = 64;
const MAX_CLAIM_NAME_LENGTH = 128;
const MAX_UID_LENGTH = 128;

type Fields = Record<string, unknown>;

/** Each app's Auth, as the live Auth row handed it to the app. */
const AUTH_BY_APP = new WeakMap<object, object>();

function isObject(value: unknown): value is Fields {
  return (typeof value === 'object' || typeof value === 'function') && value !== null;
}

/** Whether a value is an Auth instance: it has an app and a `currentUser` slot. */
function isAuth(value: unknown): boolean {
  return isObject(value) && 'currentUser' in value && isObject(value.app);
}

/**
 * The page's list of the Auth instances this row handed the app, shared with
 * the cli page runtime (`serve/runtime/live-identity.ts` in `@pyric/cli`),
 * which loads as a separate bundle. The runtime reads the signed-in user
 * from the app's own Auth through it. It holds Auth instances only, never a
 * user's profile.
 */
const AUTH_HUB_KEY = Symbol.for('pyric.live.auths');

interface AuthHub {
  readonly auths: object[];
  readonly listeners: Set<(auth: object) => void>;
}

function authHub(): AuthHub {
  const scope = globalThis as { [AUTH_HUB_KEY]?: AuthHub };
  return scope[AUTH_HUB_KEY] ??= { auths: [], listeners: new Set() };
}

/** Lists an Auth on the page hub once, and tells each hub listener. */
function publishAuth(auth: object): void {
  const hub = authHub();
  const isListed = hub.auths.includes(auth);
  if (isListed) return;
  hub.auths.push(auth);
  for (const listener of hub.listeners) listener(auth);
}

/**
 * Notes the Auth instance `getAuth` or `initializeAuth` returned, so later
 * calls on its app can name the account and the page runtime can read its
 * user. Anything else is ignored.
 */
export function noteAuth(auth: unknown): void {
  try {
    if (!isAuth(auth)) return;
    AUTH_BY_APP.set((auth as Fields).app as object, auth as Fields);
    publishAuth(auth as Fields);
  } catch {
    // A value that throws on read is not an Auth instance; the app's call is unchanged.
  }
}

/** The app a call's first argument belongs to: a reference or query, a Firestore or Auth instance, or the app. */
function appOf(subject: Fields): unknown {
  const firestore = subject.firestore;
  if (isObject(firestore) && isObject(firestore.app)) return firestore.app;
  if (isObject(subject.app)) return subject.app;
  return subject;
}

/** The Auth a call's first argument reaches: itself, a user's `auth`, or its app's noted Auth. */
function authOf(subject: unknown): Fields | undefined {
  if (!isObject(subject)) return undefined;
  if (isAuth(subject)) return subject;
  if (isAuth(subject.auth)) return subject.auth as Fields;
  const app = appOf(subject);
  if (!isObject(app)) return undefined;
  const auth = AUTH_BY_APP.get(app);
  return isAuth(auth) ? (auth as Fields) : undefined;
}

/** The bytes of a base64url segment as text, or undefined when it is not base64url. */
function decodeSegment(segment: string): string | undefined {
  const isBase64Url = /^[A-Za-z0-9_-]+$/.test(segment);
  if (!isBase64Url) return undefined;
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * An ID token's claims, or undefined when the value is not a JWT with an
 * object payload. The signature is not read, so a signed production token
 * and an unsigned emulator token read alike.
 */
function claimsOf(token: unknown): Fields | undefined {
  if (typeof token !== 'string') return undefined;
  const segments = token.split('.');
  const isJwt = segments.length === 3;
  if (!isJwt) return undefined;
  try {
    const payload = decodeSegment(segments[1]!);
    if (payload === undefined) return undefined;
    const claims: unknown = JSON.parse(payload);
    const isClaims = isObject(claims) && !Array.isArray(claims);
    return isClaims ? claims : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The sorted names of an ID token's claims, or undefined when the value is
 * not a JWT with an object payload. Names a host would refuse (empty or too
 * long) are left out, and at most 64 are kept.
 */
export function claimNamesOf(token: unknown): string[] | undefined {
  const claims = claimsOf(token);
  if (claims === undefined) return undefined;
  const names = Object.keys(claims).filter((name) => name.length > 0 && name.length <= MAX_CLAIM_NAME_LENGTH);
  return names.sort().slice(0, MAX_CLAIM_NAMES);
}

/** `firebase.identities` without its `email` list, the account's sign-in emails. */
function withoutIdentityEmails(firebase: unknown): unknown {
  if (!isObject(firebase) || !isObject(firebase.identities)) return firebase;
  const { email: _email, ...identities } = firebase.identities;
  return { ...firebase, identities };
}

/**
 * An ID token's claim values, with the account's `email` and the emails in
 * `firebase.identities` left out, or undefined when the value is not a JWT
 * with an object payload.
 */
export function claimValuesOf(token: unknown): Record<string, unknown> | undefined {
  const claims = claimsOf(token);
  if (claims === undefined) return undefined;
  const { email: _email, ...rest } = claims;
  const hasFirebase = 'firebase' in rest;
  return hasFirebase ? { ...rest, firebase: withoutIdentityEmails(rest.firebase) } : rest;
}

/**
 * The account a call whose first argument is `subject` runs as, or
 * undefined when it runs signed out or names no Auth this row handed out.
 */
export function accountOf(subject: unknown): LiveAccount | undefined {
  try {
    const user = authOf(subject)?.currentUser;
    if (!isObject(user)) return undefined;
    const uid = user.uid;
    const isUid = typeof uid === 'string' && uid.length > 0 && uid.length <= MAX_UID_LENGTH;
    if (!isUid) return undefined;
    const claimNames = claimNamesOf(user.accessToken);
    if (claimNames === undefined) return { uid };
    const claims = claimValuesOf(user.accessToken);
    return claims === undefined ? { uid, claimNames } : { uid, claimNames, claims };
  } catch {
    return undefined;
  }
}
