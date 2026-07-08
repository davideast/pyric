/**
 * Sign-in helper core for `pyric serve` — the framework-free controller
 * behind the account-picker dialog (the emulator's sign-in widget analog,
 * and the second consumer of `pyric/auth`'s `AuthFlowResolver` seam after
 * the playground; same settle/seed semantics, zero DOM).
 *
 * `resolver()` parks the SDK's popup/redirect promise; `pick`/`add`/`cancel`
 * settle it. `add()` seeds the identity into the sandbox user DB first so
 * `request.auth.token.*` claims resolve in rules AND the identity shows in
 * the picker next time (the uid-join-key lesson from the auth audit).
 *
 * Bun-testable without a browser — the `<dialog>` shell in
 * `./auth-helper-dom.ts` is a thin view over `subscribe`/`snapshot` and the
 * three actions.
 */
import {
  getAuth,
  sandbox as authSandbox,
  type Auth,
  type AuthFlowRequest,
  type AuthFlowResolver,
  type User,
  type UserCredential,
} from 'pyric/auth';
import type { Sandbox } from 'pyric/sandbox';

export interface NewIdentitySpec {
  email: string;
  displayName?: string;
  /** Parsed custom claims (the emulator's `customAttributes`). */
  customClaims?: Record<string, unknown>;
}

export interface HelperSnapshot {
  /** The in-flight request, or null when no popup/redirect is pending. */
  request: AuthFlowRequest | null;
  identities: ReturnType<typeof authSandbox.listIdentities>;
}

/** Seeds need a password field; popup identities never sign in with one. */
const SYNTHETIC_PASSWORD = '__pyric_popup_no_password__';

type Pending = {
  req: AuthFlowRequest;
  resolve: (c: UserCredential) => void;
  reject: (e: unknown) => void;
};

export class ServeAuthHelper {
  private pending: Pending | null = null;
  private readonly listeners = new Set<() => void>();
  private cached: HelperSnapshot | null = null;
  private readonly auth: Auth;

  constructor(sandbox: Sandbox) {
    this.auth = getAuth(sandbox);
  }

  /** Wire this helper into the page's auth. Call once at init. */
  install(): void {
    authSandbox.setAuthFlowResolver(this.auth, this.resolver());
  }

  resolver(): AuthFlowResolver {
    const open = (req: AuthFlowRequest): Promise<UserCredential> =>
      new Promise<UserCredential>((resolve, reject) => {
        if (this.pending) this.cancel(); // one dialog at a time
        this.pending = { req, resolve, reject };
        this.emit();
      });
    return { openPopup: open, openRedirect: open };
  }

  // ─── view glue ──────────────────────────────────────────────────────
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): HelperSnapshot {
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

  // ─── actions ────────────────────────────────────────────────────────
  pick(uid: string): void {
    const p = this.take();
    if (!p) return;
    const id = authSandbox.listIdentities(this.auth).find((i) => i.uid === uid);
    if (!id) {
      p.reject(authError('auth/internal-error', `unknown identity ${uid}`));
      return;
    }
    p.resolve(this.credential(id.uid, id.email, id.displayName, id.customClaims, p.req.providerId));
  }

  add(spec: NewIdentitySpec): void {
    const p = this.take();
    if (!p) return;
    const uid = `${p.req.providerId}:${spec.email}`;
    authSandbox.seedUsers(this.auth, [
      {
        uid,
        email: spec.email,
        password: SYNTHETIC_PASSWORD,
        displayName: spec.displayName,
        customClaims: spec.customClaims ?? {},
      },
    ]);
    p.resolve(
      this.credential(uid, spec.email, spec.displayName ?? null, spec.customClaims ?? {}, p.req.providerId),
    );
  }

  cancel(): void {
    const p = this.take();
    if (!p) return;
    p.reject(
      authError(
        'auth/popup-closed-by-user',
        'The popup has been closed by the user before finalizing the operation.',
      ),
    );
  }

  private take(): Pending | null {
    const p = this.pending;
    this.pending = null;
    this.emit();
    return p;
  }

  private credential(
    uid: string,
    email: string | null,
    displayName: string | null,
    claims: Record<string, unknown>,
    providerId: string,
  ): UserCredential {
    const user: User = {
      uid,
      email,
      displayName,
      isAnonymous: false,
      getIdToken: async () => `pyric-serve-${uid}`,
      getIdTokenResult: async () => ({
        token: `pyric-serve-${uid}`,
        claims: { sub: uid, ...claims },
        expirationTime: new Date(Date.now() + 3600_000).toISOString(),
        issuedAtTime: new Date().toISOString(),
        authTime: new Date().toISOString(),
      }),
    };
    return { user, providerId, operationType: 'signIn' };
  }
}

function authError(code: string, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.name = 'FirebaseError';
  e.code = code;
  return e;
}
