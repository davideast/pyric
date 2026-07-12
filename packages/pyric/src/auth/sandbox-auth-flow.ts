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

/**
 * One message the sandbox's auth "mail server" emitted. Produced by
 * every send-an-email API (`sendSignInLinkToEmail`,
 * `sendPasswordResetEmail`, `sendEmailVerification`,
 * `verifyBeforeUpdateEmail`).
 *
 * ─── Why a mailbox and not a stub ──────────────────────────────────
 * The email family's one genuinely unobservable step is the human
 * opening an inbox and clicking a link. Production cannot be probed
 * across that gap and neither can a test. What the sandbox does is make
 * the gap CROSSABLE instead of pretending it isn't there: the message,
 * with its real out-of-band code and its real link, lands in an outbox
 * the caller can read. `sandbox.takeAuthMail(auth)` is the program's
 * substitute for a human reading their mail — and the code in that
 * message is the same code `applyActionCode` / `signInWithEmailLink`
 * will accept, so the round trip really does close.
 *
 * That is the same move `mockSignInResult` makes for OAuth: the sandbox
 * does not fake the outcome of the external step, it hands you the seam
 * where the external step's result enters the system.
 */
export interface OutboundAuthMail {
  /** The {@link ActionCodeOperation} this message authorizes. */
  operation: string;
  /** Recipient. */
  email: string;
  /** The out-of-band code the recipient would redeem. */
  code: string;
  /** The full action link the message would contain — the exact string
   *  `signInWithEmailLink` / `parseActionCodeURL` accept. */
  link: string;
  /** For `VERIFY_AND_CHANGE_EMAIL`: the address being moved TO. */
  newEmail?: string;
}

/**
 * Notified for every message the sandbox's auth mail server emits — the
 * analog of {@link AuthFlowResolver} for the email family. A host (the
 * playground) installs one to surface the link in its UI; a headless
 * test reads {@link AuthFlowRegistry.takeMail} instead.
 *
 * Advisory, not a gate: the message is written to the outbox whether or
 * not a resolver is installed, because in this model the sandbox IS the
 * mail server — the mail exists regardless of who is watching.
 */
export interface AuthMailResolver {
  deliver(mail: OutboundAuthMail): void;
}

/**
 * What one staged out-of-band code authorizes. The sandbox's action-code
 * store maps `code -> AuthActionCode`; the consumers
 * (`applyActionCode`, `checkActionCode`, `confirmPasswordReset`,
 * `verifyPasswordResetCode`, `signInWithEmailLink`) redeem against it.
 */
export interface AuthActionCode {
  /** One of {@link ActionCodeOperation}. */
  operation: string;
  /** The account the code acts on. */
  email: string;
  /** For `VERIFY_AND_CHANGE_EMAIL`: the address being moved TO. */
  newEmail?: string;
  /** When true, redeeming throws `auth/expired-action-code` instead of
   *  applying. Staged deliberately by `sandbox.mockActionCode` so the
   *  expiry branch is reachable without waiting out a real TTL. */
  expired?: boolean;
}

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

  // ─── Action-code store (the email family's staging slot) ────────────

  /** Live out-of-band codes: `code -> what it authorizes`. The email
   *  APIs mint into this map; the action-code consumers redeem from it. */
  private readonly actionCodes = new Map<string, AuthActionCode>();

  /** Monotonic serial behind {@link mintActionCode}. A counter, not a
   *  random string: a sandbox code that is stable across runs makes a
   *  failing test reproducible, and there is no secrecy requirement here
   *  (the whole point is that the test can read it). */
  private nextCodeSerial = 1;

  /** Messages the sandbox's mail server has emitted, oldest first. */
  private readonly outbox: OutboundAuthMail[] = [];

  /** Installed {@link AuthMailResolver}, or null. */
  private mailResolver: AuthMailResolver | null = null;

  /** Mint a fresh, unique out-of-band code and register what it
   *  authorizes. Returns the code. */
  mintActionCode(spec: AuthActionCode): string {
    const code = `sandbox-oob-${this.nextCodeSerial++}`;
    this.actionCodes.set(code, spec);
    return code;
  }

  /** Register a caller-supplied code (the `sandbox.mockActionCode` test
   *  driver — lets a test stage a KNOWN code, including an expired one). */
  stageActionCode(code: string, spec: AuthActionCode): void {
    this.actionCodes.set(code, spec);
  }

  /** Look at a code WITHOUT redeeming it — backs `checkActionCode` and
   *  `verifyPasswordResetCode`, both of which inspect without consuming
   *  (a `checkActionCode` must not burn the code the subsequent
   *  `applyActionCode` needs). */
  peekActionCode(code: string): AuthActionCode | undefined {
    return this.actionCodes.get(code);
  }

  /** Redeem a code: read it and burn it, so it cannot be replayed —
   *  matching prod, where an out-of-band code is single-use. */
  consumeActionCode(code: string): AuthActionCode | undefined {
    const spec = this.actionCodes.get(code);
    if (spec) this.actionCodes.delete(code);
    return spec;
  }

  // ─── Mail outbox ────────────────────────────────────────────────────

  setMailResolver(resolver: AuthMailResolver | null): void {
    this.mailResolver = resolver;
  }

  /** Emit a message. Always recorded in the outbox (the sandbox IS the
   *  mail server); additionally handed to an installed resolver, whose
   *  throw is contained — a host UI that fails to render a link must not
   *  fail the `sendPasswordResetEmail` call that produced it. */
  deliverMail(mail: OutboundAuthMail): void {
    this.outbox.push(mail);
    if (this.mailResolver) {
      try {
        this.mailResolver.deliver(mail);
      } catch {
        // Contained on purpose — see above.
      }
    }
  }

  /** Read and remove the oldest message, optionally filtered to one
   *  recipient. The program's stand-in for a human opening their inbox. */
  takeMail(email?: string): OutboundAuthMail | null {
    const i = email === undefined
      ? (this.outbox.length > 0 ? 0 : -1)
      : this.outbox.findIndex((m) => m.email.toLowerCase() === email.toLowerCase());
    if (i < 0) return null;
    return this.outbox.splice(i, 1)[0] ?? null;
  }

  /** Every message currently in the outbox, oldest first. Non-destructive. */
  listMail(): OutboundAuthMail[] {
    return [...this.outbox];
  }
}
