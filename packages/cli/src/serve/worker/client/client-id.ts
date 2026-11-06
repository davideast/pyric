/**
 * This browser profile's id, which a page or service worker declares in its
 * `appConfig` as `clientId` and the host stamps on its events as
 * `caller.clientId`. `localStorage` keeps it, so every tab of one profile and
 * origin sends the same one; another profile, another browser or a private
 * window mints its own.
 *
 * The first id a realm reads is kept for the realm, so every port of a tab
 * sends the same one even when the app clears `localStorage` (a sign-out) or
 * another tab mints at the same moment. A cleared store gets the id written
 * back, so later tabs still agree. A realm without `localStorage` (a service
 * worker, a worker, a Node process) or one that refuses it keeps an id minted
 * once in memory.
 *
 * Named `profileClientId` here, apart from presence's per-page `clientId`
 * (`presence.ts`), which names one logical page, not a profile.
 *
 * A label, never an authority: it is random, and never read from a uid, a
 * token or anything else the page holds.
 */
const PROFILE_CLIENT_ID_KEY = 'pyric.profileClientId';
const PROFILE_CLIENT_ID_PATTERN = /^profile-[0-9a-f]{32}$/;

/** The first id this realm read or minted; every later call returns it. */
let realmProfileClientId: string | undefined;

/** 16 random bytes as hex. An id, not a secret: `Math.random` serves where `crypto` is missing. */
function randomHex(): string {
  const bytes = new Uint8Array(16);
  const random = globalThis.crypto;
  const hasCrypto = random !== undefined && typeof random.getRandomValues === 'function';
  if (hasCrypto) random.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function mintProfileClientId(): string {
  return `profile-${randomHex()}`;
}

/** A stored value is kept only in the minted form, so nothing else in storage becomes the id. */
function isMintedId(value: string | null): value is string {
  return value !== null && PROFILE_CLIENT_ID_PATTERN.test(value);
}

function storedProfileClientId(): string | undefined {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined) return undefined;
    const stored = storage.getItem(PROFILE_CLIENT_ID_KEY);
    if (isMintedId(stored)) return stored;
    const minted = mintProfileClientId();
    storage.setItem(PROFILE_CLIENT_ID_KEY, minted);
    return minted;
  } catch {
    return undefined;
  }
}

/** Write the realm's id back where the store lost it; an id another tab minted is left as it is. */
function restoreStoredProfileClientId(id: string): void {
  try {
    const storage = globalThis.localStorage;
    if (storage === undefined) return;
    if (isMintedId(storage.getItem(PROFILE_CLIENT_ID_KEY))) return;
    storage.setItem(PROFILE_CLIENT_ID_KEY, id);
  } catch {
    // A store that refuses access keeps nothing; the realm's id still stands.
  }
}

export function profileClientId(): string {
  if (realmProfileClientId === undefined) {
    realmProfileClientId = storedProfileClientId() ?? mintProfileClientId();
    return realmProfileClientId;
  }
  restoreStoredProfileClientId(realmProfileClientId);
  return realmProfileClientId;
}
