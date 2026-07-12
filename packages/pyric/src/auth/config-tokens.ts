/**
 * Inert configuration tokens — the persistence markers, the popup/redirect
 * resolver token, and the two error maps.
 *
 * ─── What "inert" means here, precisely ─────────────────────────────
 * Every value in this file is a value consumer code PASSES somewhere
 * (`setPersistence(auth, browserLocalPersistence)`,
 * `initializeAuth(app, { persistence, popupRedirectResolver, errorMap })`)
 * rather than a value it reads behavior out of. The sandbox accepts them
 * and, for persistence, records the mode; none of them can do their real
 * job here, because their real job is to reach a browser storage backend,
 * a popup window, or a message table that the sandbox does not have.
 *
 * They are mirrored anyway, and NOT as a courtesy: an app that writes the
 * idiomatic `initializeAuth(app, { persistence: indexedDBLocalPersistence })`
 * does not fail to bundle, does not throw, and behaves identically —
 * because in an in-memory sandbox the persistence choice genuinely has no
 * observable consequence. This is the same "honest inert token" pattern
 * `pyric/firestore` already uses for its cache-factory tokens.
 *
 * The one thing that is NOT inert is the `.type` discriminant: consumer
 * code branches on it, so it must match upstream exactly.
 *
 * ─── An oracle caveat, recorded because it would otherwise mislead ──
 * `auth-mechanical-surface-constants` captured `type: 'NONE'` for EVERY
 * persistence token — including `browserLocalPersistence`, which is
 * unambiguously `'LOCAL'` upstream. That is an artifact of the harness:
 * it runs under Node, where firebase/auth ships stubs for the browser-only
 * tokens. The capture is committed as-is (it is what we saw), the
 * conformance suite does NOT assert persistence types from it, and the
 * values below follow the documented `Persistence.type` union instead.
 * An observation you have to explain is still better than one you quietly
 * discard.
 */

import type { Persistence } from './types.js';

// ─── Persistence markers ──────────────────────────────────────────────

/** No persistence — session dies with the tab. */
export const inMemoryPersistence: Persistence = { type: 'NONE' };
/** `sessionStorage`-backed. */
export const browserSessionPersistence: Persistence = { type: 'SESSION' };
/** `localStorage`-backed. Firebase's default. */
export const browserLocalPersistence: Persistence = { type: 'LOCAL' };
/** IndexedDB-backed. Long-term, same observable class as
 *  `browserLocalPersistence` — hence the shared `'LOCAL'` type. */
export const indexedDBLocalPersistence: Persistence = { type: 'LOCAL' };
/** Cookie-backed, for SSR. The fourth member of upstream's
 *  `Persistence.type` union. */
export const browserCookiePersistence: Persistence = { type: 'COOKIE' };

// ─── Popup / redirect resolver token ──────────────────────────────────

/**
 * `browserPopupRedirectResolver` — upstream's default resolver, the thing
 * a browser `getAuth()` wires in so `signInWithPopup` can open a window.
 *
 * The sandbox has no window to open, and it already has a FIRST-CLASS,
 * pluggable equivalent: {@link AuthFlowResolver}, installed via
 * `sandbox.setAuthFlowResolver`. So this export exists to satisfy the
 * idiomatic `initializeAuth(app, { popupRedirectResolver:
 * browserPopupRedirectResolver })` without changing anything: passing it
 * is accepted and ignored, and popup/redirect sign-in resolves through
 * the sandbox's own resolver seam instead.
 *
 * Branded rather than left as a bare `{}` so a host can recognize it.
 */
export const browserPopupRedirectResolver: { readonly _pyricResolverToken: 'browser-popup-redirect' } = {
  _pyricResolverToken: 'browser-popup-redirect',
};

// ─── Error maps ───────────────────────────────────────────────────────

/**
 * An error map — upstream's `AuthErrorMap`. Passed to `initializeAuth`
 * to control how much detail a thrown `FirebaseError` carries.
 */
export type AuthErrorMap = () => Record<string, string>;

/**
 * `debugErrorMap` — upstream's verbose map: full human-readable messages
 * on every auth error, at the cost of bundle size.
 *
 * The sandbox ALWAYS throws with a full message (see `auth-errors.ts`:
 * every `makeAuthError` call site passes real prose), so the debug map is
 * effectively already in force and installing it changes nothing. Exported
 * as an accepted no-op token.
 */
export const debugErrorMap: AuthErrorMap = () => ({});

/**
 * `prodErrorMap` — upstream's minified map: error codes without the
 * message text, to save bytes in production builds.
 *
 * NOT honored, deliberately. Installing it upstream STRIPS the messages;
 * doing that in a sandbox whose entire purpose is to tell a developer what
 * went wrong would be actively hostile. Accepted and ignored — the sandbox
 * keeps throwing full messages.
 */
export const prodErrorMap: AuthErrorMap = () => ({});
