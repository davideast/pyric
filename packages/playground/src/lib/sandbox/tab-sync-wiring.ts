/**
 * Cross-tab auth synchronization for the playground workspace sandbox.
 *
 * Mirrors `packages/pyric-tools/src/serve/entries/tab-sync-wiring.ts` —
 * that file is an internal of `pyric-tools` and CANNOT be imported here
 * (the playground is a consumer, not a peer). The logic is identical;
 * only the default channel name differs (`pyric:playground:auth-sync:*`
 * vs. `pyric:serve:auth-sync`).
 *
 * Two independent channels carry two independent kinds of state in the
 * playground's workspace runner:
 *
 *   1. Firestore data   — handled by `sandbox.enableTabSync()` (the library
 *      primitive). The runner supplies a per-session BroadcastChannel so
 *      only tabs viewing the SAME session sync Firestore writes.
 *
 *   2. Auth state       — `enableTabSync` carries Firestore write events only;
 *      sign-in / sign-out lives outside the Firestore environment. This file
 *      bridges auth over a SECOND per-session channel using a full-state
 *      protocol: any auth change broadcasts the complete user DB + current UID;
 *      a new tab announces itself with `hello` and receives the current state
 *      in reply.
 *
 * Why full-state instead of deltas?
 *   Auth payloads are tiny (a handful of users). Broadcasting the entire user
 *   DB + current UID on every change avoids ordering bugs where a `seedUsers`
 *   arrives before a `restoreSession` (or vice versa) and leaves the receiving
 *   tab in an inconsistent partial state. One atomic message = one safe apply.
 *
 * Echo-loop prevention (load-bearing):
 *   Applying a received auth state calls `seedUsers` + `restoreSession`, which
 *   fire `subscribeUsers` / `onAuthStateChanged` callbacks — the same callbacks
 *   that trigger outbound broadcasts. Without a guard this creates an infinite
 *   cross-tab loop. The `applyingRemoteAuth` boolean breaks it: set to `true`
 *   immediately before the apply and `false` in the `finally` block; both
 *   broadcast callbacks check the flag and no-op while it is set.
 *   JavaScript is single-threaded, and `seedUsers` + `restoreSession` are
 *   synchronous (they resolve before any pending microtask can enter), so the
 *   boolean is collision-free.
 *
 * Late-join (hello/state):
 *   A tab that opens AFTER others have already signed in broadcasts `hello` on
 *   init. Any peer that receives it replies with `state` (full user DB +
 *   currentUid). The joining tab receives that `state` and calls
 *   `seedUsers` + `restoreSession` to catch up. The existing tabs'
 *   `onAuthStateChanged` listeners fire as a result, exactly as they would in
 *   production.
 *
 * Per-session scoping (non-negotiable):
 *   The channel name MUST include the persistence key (which encodes the
 *   session id). Different sessions use different channel names so they
 *   never cross-wire. This is enforced in the runner: the channel is created
 *   as `new BroadcastChannel('pyric:playground:auth-sync:' + persistence.key)`.
 *
 * Origin tagging:
 *   Every message carries an `origin` equal to the sending tab's random ID.
 *   Receiving tabs drop messages whose `origin` equals their own ID — both to
 *   comply with the echo guard and to be correct on injected test channels that
 *   may deliver messages back to the sender (the real BroadcastChannel spec does
 *   NOT deliver to the sender, but test stubs may differ).
 */

import type { Auth, SeedUser } from 'pyric/auth';

// ─── Auth channel message shapes ─────────────────────────────────────────────

/** Full auth state broadcast whenever auth changes or in response to a hello. */
interface AuthStateMessage {
  kind: 'state';
  /** Sending tab's random ID — used for echo suppression. */
  origin: string;
  /** Complete user DB snapshot in the shape `seedUsers` accepts. */
  users: SeedUser[];
  /** UID of the signed-in user, or null when signed out. */
  currentUid: string | null;
}

/** Sent by a new tab on init to request the current auth state from peers. */
interface AuthHelloMessage {
  kind: 'hello';
  /** Sending tab's random ID. */
  origin: string;
}

type AuthSyncMessage = AuthStateMessage | AuthHelloMessage;

/** Loose type guard — checks the discriminant fields only. */
function isAuthSyncMessage(v: unknown): v is AuthSyncMessage {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).kind === 'string' &&
    typeof (v as Record<string, unknown>).origin === 'string'
  );
}

// ─── Auth ops interface (injected to keep this module testable) ───────────────

/**
 * The subset of `pyric/auth`'s `sandbox` namespace that we need.
 * Injected so unit tests can stub without a real sandbox.
 */
export interface AuthOps {
  exportUsers(auth: Auth): SeedUser[];
  seedUsers(auth: Auth, users: ReadonlyArray<SeedUser>): void;
  restoreSession(auth: Auth, uid: string): void;
  subscribeUsers(auth: Auth, callback: () => void): () => void;
}

// ─── Minimal BroadcastChannel-like interface ──────────────────────────────────

/** Minimal shape that both `BroadcastChannel` and injected test stubs satisfy. */
export interface ChannelLike {
  postMessage(msg: unknown): void;
  addEventListener(type: 'message', l: (ev: { data: unknown }) => void): void;
  removeEventListener(type: 'message', l: (ev: { data: unknown }) => void): void;
  close(): void;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Wire cross-tab auth synchronization for a playground workspace sandbox.
 *
 * Call once, after the sandbox and auth are initialised. The function is a
 * no-op when `BroadcastChannel` is not available (SSR / Node environments —
 * the Bun test suite lacks BroadcastChannel and relies on this guard to stay
 * inert).
 *
 * @param auth        The `Auth` handle (from `getAuth(sandbox)`).
 * @param authOps     The `sandbox` namespace from `pyric/auth`.
 * @param onAuthStateChanged  `onAuthStateChanged` from `pyric/auth`.
 * @param signOut     `signOut` from `pyric/auth`.
 * @param channel     Injected channel (required — the runner creates a per-
 *                    session `BroadcastChannel` and passes it in so channel
 *                    lifecycle is owned by the runner's `dispose()`).
 * @param originId    Optional injected origin ID (omit in production).
 *
 * @returns A disable function that removes all listeners (but does NOT close
 *          the channel — the caller owns it). Safe to call multiple times.
 */
export function wireAuthTabSync(
  auth: Auth,
  authOps: AuthOps,
  onAuthStateChanged: (auth: Auth, cb: (user: unknown) => void) => () => void,
  signOut: (auth: Auth) => Promise<void>,
  channel: ChannelLike,
  originId?: string,
): () => void {
  const origin: string =
    originId ??
    (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `auth-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  // ── Echo / loop guard ────────────────────────────────────────────────────
  //
  // WHY: applying a received `state` calls `seedUsers` (fires `subscribeUsers`
  // callbacks) and `restoreSession` (fires `onAuthStateChanged` callbacks).
  // Both of those callbacks are hooked to broadcast the current state outward.
  // Without this guard, the sequence would loop: Tab A signs in → broadcasts →
  // Tab B receives → applies → subscribeUsers/onAuthStateChanged fire in Tab B
  // → Tab B broadcasts → Tab A receives → applies → loops.
  //
  // Setting this flag to `true` around the synchronous apply block prevents
  // the outbound broadcast callbacks from posting. Both `seedUsers` and
  // `restoreSession` are synchronous; JS is single-threaded — the flag is
  // reset to `false` before any micro/macrotask can re-enter.
  let applyingRemoteAuth = false;

  // ── Debounced outbound broadcast ─────────────────────────────────────────
  //
  // Debounce (~100ms) coalesces a `seedUsers` + `restoreSession` pair (which
  // fires both subscribeUsers AND onAuthStateChanged in quick succession) into
  // a single outbound message. Without debounce the two callbacks could send
  // two rapid-fire broadcasts to peers, causing redundant double-applies.
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleBroadcast(): void {
    // Skip if we're currently applying a remote state — that would echo.
    if (applyingRemoteAuth) return;
    if (broadcastTimer !== null) clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (applyingRemoteAuth) return; // double-check after the debounce delay
      broadcastCurrentState();
    }, 100);
  }

  function broadcastCurrentState(): void {
    const msg: AuthStateMessage = {
      kind: 'state',
      origin,
      users: authOps.exportUsers(auth),
      currentUid: auth.currentUser?.uid ?? null,
    };
    channel.postMessage(msg);
  }

  // ── Subscribe to local auth changes ──────────────────────────────────────
  //
  // Two hooks cover the two dimensions of auth state:
  //   - `subscribeUsers` fires when the user DB changes (new user created,
  //     user properties changed, user deleted). This carries the FULL user DB.
  //   - `onAuthStateChanged` fires when the signed-in session changes (sign in,
  //     sign out, session swap). This carries `currentUid`.
  //
  // Broadcasting on BOTH ensures sign-in (changes currentUid without touching
  // users DB), sign-up (creates a user AND changes currentUid), and user-DB
  // edits all propagate. They share the debounce so a sign-up that fires
  // subscribeUsers first and onAuthStateChanged second sends one message, not two.

  const unsubUsers = authOps.subscribeUsers(auth, scheduleBroadcast);
  const unsubAuthState = onAuthStateChanged(auth, scheduleBroadcast);

  // ── Receive remote auth state ─────────────────────────────────────────────

  const handleMessage = async (ev: { data: unknown }): Promise<void> => {
    if (!isAuthSyncMessage(ev.data)) return;
    const msg = ev.data;

    // Echo suppression: ignore messages from ourselves.
    if (msg.origin === origin) return;

    if (msg.kind === 'hello') {
      // A new tab joined and wants the current state. Reply immediately (no
      // debounce — this is a direct reply to a single event, not a user write).
      broadcastCurrentState();
      return;
    }

    if (msg.kind === 'state') {
      // Apply received full auth state under the echo guard.
      //
      // Order is critical:
      //   1. seedUsers FIRST — ensures the uid in `currentUid` exists in the DB.
      //      restoreSession throws 'user-not-found' if the uid is absent, which
      //      would leave the tab signed out even though the peer is signed in.
      //   2. restoreSession SECOND — re-establishes the signed-in session.
      //      If `currentUid` is null, sign out instead (sign-out in Tab A must
      //      flow through to Tab B).
      applyingRemoteAuth = true;
      try {
        authOps.seedUsers(auth, msg.users);
        if (msg.currentUid) {
          try {
            authOps.restoreSession(auth, msg.currentUid);
          } catch {
            // uid was in the exported list but restoreSession still failed
            // (e.g. user disabled between export and apply). Sign out to stay
            // consistent with the peer's next broadcast rather than silently
            // leaving the tab in a stale signed-in state.
            await signOut(auth).catch(() => {});
          }
        } else {
          // Peer signed out — mirror that here.
          await signOut(auth).catch(() => {});
        }
      } finally {
        applyingRemoteAuth = false;
      }
    }
  };

  channel.addEventListener('message', handleMessage);

  // ── Late-join hello ───────────────────────────────────────────────────────
  //
  // Post a `hello` AFTER wiring the message listener so we don't miss a `state`
  // reply that arrives while still setting up (relevant on injected synchronous
  // test channels). Peers reply with their current auth state; we apply it in
  // `handleMessage` above. This lets a freshly-opened tab immediately inherit
  // the signed-in user from an already-open tab without waiting for the next
  // user-driven auth change.
  const helloMsg: AuthHelloMessage = { kind: 'hello', origin };
  channel.postMessage(helloMsg);

  // ── Disable ───────────────────────────────────────────────────────────────
  // NOTE: we do NOT close the channel here — the runner that created it owns
  // its lifecycle and closes it in dispose().

  return () => {
    if (broadcastTimer !== null) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
    unsubUsers();
    unsubAuthState();
    channel.removeEventListener('message', handleMessage);
  };
}
