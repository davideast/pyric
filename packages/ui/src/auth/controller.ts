/**
 * Sign-in helper controller — the host side of `pyric/auth`'s
 * `AuthFlowResolver` seam.
 *
 * `pyric/auth` stays UI-free: `signInWithPopup` / `signInWithRedirect`
 * delegate to a resolver. This controller IS that resolver's host
 * implementation — it parks the SDK's promise, drives a host UI (an
 * account picker + add-account form, e.g. `<AuthSignInHelper>`), and
 * settles the promise when the user picks an identity, adds one, or
 * cancels. React components stay thin presentational shells over this;
 * all the settle/seed logic lives here so it's testable without a DOM.
 *
 * Faithful to the Firebase emulator: "add account" mints a sandbox
 * identity with optional custom claims (the emulator's
 * `customAttributes`), so a rule gated on `request.auth.token.<claim>`
 * works against live sandbox traffic. Credential + token synthesis is
 * backend-owned (`sandbox.createSignInCredential`) — this controller
 * only drives the UI flow and settles the parked promise.
 */
import {
  sandbox as authSandbox,
  type Auth,
  type AuthFlowRequest,
  type AuthFlowResolver,
  type UserCredential,
} from 'pyric/auth';

/** A field set for "add new account" — mirrors the emulator's add-user form. */
export interface NewIdentitySpec {
  email: string;
  displayName?: string;
  /** Parsed custom claims (the emulator's `customAttributes`). */
  customClaims?: Record<string, unknown>;
}

/** One pickable identity, as reported by `sandbox.listIdentities`. */
export type SandboxIdentity = ReturnType<typeof authSandbox.listIdentities>[number];

/** Snapshot the helper UI renders from. */
export interface HelperState {
  /** The in-flight request, or null when the helper is closed. */
  request: AuthFlowRequest | null;
  /** Existing identities to pick from (seeded + previously created). */
  identities: SandboxIdentity[];
}

type Pending = {
  req: AuthFlowRequest;
  resolve: (c: UserCredential) => void;
  reject: (e: unknown) => void;
};

export class AuthFlowController {
  private pending: Pending | null = null;
  private readonly listeners = new Set<() => void>();
  /** Memoized {@link snapshot} result, invalidated by {@link emit}.
   *  `useSyncExternalStore` compares consecutive `getSnapshot()` results
   *  with `Object.is` — an uncached object here re-renders forever. */
  private cached: HelperState | null = null;

  constructor(private readonly auth: Auth) {}

  /** Wire this controller's resolver into the auth handle. Paired with
   *  {@link uninstall} for use in a React effect (install in the body,
   *  uninstall in the cleanup) — StrictMode-safe. */
  install(): void {
    authSandbox.setAuthFlowResolver(this.auth, this.resolver());
  }

  uninstall(): void {
    authSandbox.setAuthFlowResolver(this.auth, null);
  }

  /** The resolver to hand to `sandbox.setAuthFlowResolver`. Popup and
   *  redirect share one implementation (the sandbox has no navigation). */
  resolver(): AuthFlowResolver {
    const open = (req: AuthFlowRequest): Promise<UserCredential> =>
      new Promise<UserCredential>((resolve, reject) => {
        // One helper at a time: a new request supersedes any stale pending.
        if (this.pending) this.cancel();
        this.pending = { req, resolve, reject };
        this.emit();
      });
    return { openPopup: open, openRedirect: open };
  }

  // ─── React glue (subscribe + snapshot) ──────────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): HelperState {
    this.cached ??= {
      request: this.pending?.req ?? null,
      identities: authSandbox.listIdentities(this.auth),
    };
    return this.cached;
  }

  private emit(): void {
    this.cached = null;
    for (const l of this.listeners) l();
  }

  // ─── UI actions ─────────────────────────────────────────────────────
  /** Pick an existing identity (by uid). The backend mints the credential
   *  (and records the provider on the identity). */
  pick(uid: string): void {
    const pending = this.pending;
    if (!pending) return;
    let cred: UserCredential;
    try {
      cred = authSandbox.createSignInCredential(this.auth, {
        providerId: pending.req.providerId,
        uid,
      });
    } catch (e) {
      this.take()?.reject(e);
      return;
    }
    this.take()?.resolve(cred);
  }

  /** Add + sign in as a new identity. The backend creates the identity
   *  (so claims resolve in rules and it shows up in the picker next time)
   *  and mints the credential in one step.
   *
   *  Credential creation happens BEFORE {@link take}'s emit: subscribers
   *  recompute the snapshot synchronously on emit, so creating after would
   *  publish a stale identity list (a `useSyncExternalStore` consumer
   *  would miss the new account until the next unrelated emit). */
  add(spec: NewIdentitySpec): void {
    const pending = this.pending;
    if (!pending) return;
    let cred: UserCredential;
    try {
      cred = authSandbox.createSignInCredential(this.auth, {
        providerId: pending.req.providerId,
        spec: {
          email: spec.email,
          displayName: spec.displayName,
          customClaims: spec.customClaims,
        },
      });
    } catch (e) {
      this.take()?.reject(e);
      return;
    }
    this.take()?.resolve(cred);
  }

  /** Dismiss — rejects with the faithful `auth/popup-closed-by-user`. */
  cancel(): void {
    const p = this.take();
    if (!p) return;
    p.reject(authError('auth/popup-closed-by-user', 'The popup has been closed by the user before finalizing the operation.'));
  }

  private take(): Pending | null {
    const p = this.pending;
    this.pending = null;
    this.emit();
    return p;
  }
}

function authError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.name = 'FirebaseError';
  e.code = code;
  return e;
}
