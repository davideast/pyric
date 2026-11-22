/**
 * Origin tracking and portable storage helpers for served sandbox avatar URLs
 * (#581, #1244).
 *
 * Persisted records (`StoredUser.photoUrl` and `exportUsers`) always hold the
 * root-relative `/__pyric/assets/avatar/<uid>?...` path so snapshots, seeds,
 * and `.pyric/state/state.json` stay portable across ports and machines. Every
 * user-facing read surface (`User`, `providerData`, ID token `picture`,
 * `AuthUserRecord`, blocking candidates, and Auth mutation events) resolves
 * against the per-uid origin, the project store's fallback origin, or
 * `realmOrigin()`.
 */
import {
  absolutePhotoUrl,
  parseServedAvatarPhotoUrl,
  realmOrigin,
} from '../../sandbox/internal/photo-url.js';
import type { AuthProjectStore } from './project-store.js';

function isHttpOrigin(origin: string | null | undefined): origin is string {
  return typeof origin === 'string' && /^https?:\/\//.test(origin);
}

/** Record a client or host HTTP(S) origin on the shared project store. */
export function recordStorePhotoOrigin(
  store: AuthProjectStore,
  origin: string | null | undefined,
  uid?: string,
): void {
  if (!isHttpOrigin(origin)) {
    return;
  }
  store.fallbackPhotoOrigin = origin;
  if (uid !== undefined) {
    store.photoOriginByUid.set(uid, origin);
  }
}

/**
 * Normalize a photo URL before writing it to `StoredUser.photoUrl`.
 * If a caller (such as the account picker re-submitting `listUsers` output)
 * hands back an `http(s)://<host>/__pyric/assets/avatar/...` URL, record its
 * origin and store only the portable root-relative path.
 */
export function normalizeStoredPhotoUrl(
  store: AuthProjectStore,
  uid: string,
  photoUrl: string | null,
  clearOriginWhenCustom: boolean,
): string | null {
  const parsed = parseServedAvatarPhotoUrl(photoUrl);
  if (parsed !== null) {
    if (parsed.origin !== null) {
      recordStorePhotoOrigin(store, parsed.origin, uid);
    }
    return parsed.relativePath;
  }
  if (clearOriginWhenCustom) {
    store.photoOriginByUid.delete(uid);
  }
  return photoUrl;
}

/** Effective HTTP(S) origin known for `uid`, or `null` when none is known. */
function effectivePhotoOriginForUid(
  store: AuthProjectStore,
  uid: string,
): string | null {
  const perUid = store.photoOriginByUid.get(uid);
  if (perUid !== undefined) {
    return perUid;
  }
  if (store.fallbackPhotoOrigin !== null) {
    return store.fallbackPhotoOrigin;
  }
  return realmOrigin();
}

/** Resolve a stored user's `photoUrl` for any user-facing read or event snapshot. */
export function readStoredPhotoUrl(
  store: AuthProjectStore,
  stored: { readonly uid: string; readonly photoUrl: string | null },
): string | null {
  return absolutePhotoUrl(stored.photoUrl, effectivePhotoOriginForUid(store, stored.uid));
}

/** Resolve an optional relative photo URL for `uid` on event details or blocking inputs. */
export function resolvePhotoUrlForUid(
  store: AuthProjectStore,
  uid: string,
  photoUrl: string | null,
): string | null {
  return absolutePhotoUrl(photoUrl, effectivePhotoOriginForUid(store, uid));
}

/** Provider a record is being created under: explicit sign-in provider or first linked provider. */
export function creationProviderId(
  record: { readonly providerUserInfo: ReadonlyArray<{ readonly providerId: string }> },
  signInProviderId: string | null,
): string | null {
  if (signInProviderId !== null) {
    return signInProviderId;
  }
  const firstLinked = record.providerUserInfo[0];
  if (firstLinked === undefined) {
    return null;
  }
  return firstLinked.providerId;
}

/** True when a freshly built federated provider record should receive a default minted photo. */
export function mintsDefaultPhoto(
  record: { readonly photoUrl: string | null; readonly isAnonymous: boolean },
  providerId: string | null,
): providerId is string {
  if (record.photoUrl !== null || record.isAnonymous || providerId === null) {
    return false;
  }
  return providerId.includes('.');
}

/** Apply a provider sign-in's non-null photo onto an existing stored account, normalizing served avatar URLs. */
export function refreshStoredPhoto(
  store: AuthProjectStore,
  stored: { readonly uid: string; photoUrl: string | null },
  photoUrl: string | null,
): boolean {
  if (photoUrl === null) {
    return false;
  }
  const normalized = normalizeStoredPhotoUrl(store, stored.uid, photoUrl, true);
  if (stored.photoUrl === normalized) {
    return false;
  }
  stored.photoUrl = normalized;
  return true;
}
