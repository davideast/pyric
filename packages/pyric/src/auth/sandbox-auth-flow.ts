/**
 * Sandbox auth-flow registry — the popup / redirect / credential
 * staging machinery.
 *
 * ─── What this owns ────────────────────────────────────────────────
 * The one-shot, host-driven pieces of the OAuth-style sign-in flows,
 * kept as an isolated store so the coupled backend state machine (user
 * DB, listeners, token cache, current-user transitions) does not have
 * to. Three slots, each independent of every other piece of backend
 * state:
 *
 *   1. `mockResults` — pre-staged `UserCredential`s keyed by
 *      `providerId`, one slot per provider. The one-shot tier of the
 *      resolver precedence (`index.ts` `resolveFlow`:
 *      per-call resolver → injected resolver → one-shot mock → throw),
 *      consumed by the next `signInWithPopup` / `signInWithCredential`
 *      so headless conformance fixtures stay deterministic.
 *   2. `resolver` — the injected popup/redirect resolver, the analog of
 *      the browser SDK wiring `browserPopupRedirectResolver`. Null until
 *      a host (the playground) installs one via
 *      `sandbox.setAuthFlowResolver`.
 *   3. `redirectResult` — the pending `getRedirectResult` payload:
 *      set by `signInWithRedirect`, returned-and-cleared once by
 *      `getRedirectResult` (one-shot, matches prod).
 *
 * ─── Interface (the contract `SandboxBackend` delegates to) ────────
 *   setMockResult(providerId, result): void      — stage a one-shot result
 *   consumeMockResult(providerId): UserCredential | undefined
 *                                                — read + clear the slot
 *   setResolver(resolver | null): void           — install/clear resolver
 *   getResolver(): AuthFlowResolver | null       — read current resolver
 *   setRedirectResult(result): void              — stash redirect payload
 *   takeRedirectResult(): UserCredential | null  — read + clear payload
 *
 * ─── Why it is its own file (the climb seam) ───────────────────────
 * The email-link / account-linking / reauthentication climbs extend
 * exactly this "stage a result, resolve a flow, hand back a
 * credential" pattern (new staging slots + resolver entry points).
 * They land HERE. The identity mutation those flows ultimately drive
 * (user-DB upserts, provider linking, token minting, the
 * current-user transition) stays on `SandboxBackend`; this registry
 * only owns the flow-staging state, so it can grow without touching
 * the coupled auth state machine.
 *
 * No behavior of its own beyond map/slot get-set-clear — every method
 * body is verbatim from the pre-split `sandbox-backend.ts`.
 */

import type { AuthFlowResolver, UserCredential } from './types.js';

export class AuthFlowRegistry {
  /** Pre-staged sign-in results, keyed by providerId. The one-shot tier
   *  of the popup/redirect resolver precedence (see `index.ts`
   *  `signInWithPopup`): consumed when no resolver is injected, so
   *  headless conformance fixtures stay deterministic. */
  private readonly mockResults = new Map<string, UserCredential>();

  /** Injected popup/redirect resolver — the analog of browser
   *  `getAuth` wiring `browserPopupRedirectResolver`. Null until a host
   *  (the playground) installs one via `sandbox.setAuthFlowResolver`. */
  private resolver: AuthFlowResolver | null = null;

  /** Pending `getRedirectResult` payload — set by `signInWithRedirect`,
   *  returned-and-cleared by `getRedirectResult` (one-shot, matches prod). */
  private redirectResult: UserCredential | null = null;

  // ─── Mock-result registry ───────────────────────────────────────────

  setMockResult(providerId: string, result: UserCredential): void {
    this.mockResults.set(providerId, result);
  }

  consumeMockResult(providerId: string): UserCredential | undefined {
    // One-shot per stage — clear after read so the next call
    // requires a fresh `mockSignInResult`. Matches `firebase/auth`'s
    // "one popup per call" semantics.
    const result = this.mockResults.get(providerId);
    if (result) this.mockResults.delete(providerId);
    return result;
  }

  // ─── Popup/redirect resolver + redirect-result slot ─────────────────

  setResolver(resolver: AuthFlowResolver | null): void {
    this.resolver = resolver;
  }

  getResolver(): AuthFlowResolver | null {
    return this.resolver;
  }

  /** Stash the credential a `signInWithRedirect` produced; `getRedirectResult`
   *  returns-and-clears it. */
  setRedirectResult(result: UserCredential): void {
    this.redirectResult = result;
  }

  takeRedirectResult(): UserCredential | null {
    const r = this.redirectResult;
    this.redirectResult = null;
    return r;
  }
}
