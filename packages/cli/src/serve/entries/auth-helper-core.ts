/**
 * Framework-free provider account picker controller for `pyric dev`.
 *
 * The controller is intentionally backend-agnostic. It receives an identity
 * directory and returns a Firebase-shaped credential; it never constructs an
 * Auth handle or mutates a Sandbox. In SharedWorker mode the directory reads
 * the worker's user pool and the picked credential is committed by
 * `auth.acceptIdentity`. The in-page fallback supplies a small adapter over its
 * local auth user store.
 */
import type {
  AuthFlowRequest,
  AuthFlowResolver,
  User,
  UserCredential,
} from 'pyric/auth';

export interface NewIdentitySpec {
  email: string;
  displayName?: string;
  /** Parsed custom claims (the emulator's `customAttributes`). */
  customClaims?: Record<string, unknown>;
}

export interface HelperIdentity {
  uid: string;
  email: string | null;
  displayName: string | null;
  customClaims: Record<string, unknown>;
}

export interface HelperIdentityDirectory {
  list(): HelperIdentity[] | Promise<HelperIdentity[]>;
  /** Optional on the worker path: `auth.acceptIdentity` performs the write. */
  add?(identity: HelperIdentity): void | Promise<void>;
}

export interface HelperSnapshot {
  /** The in-flight request, or null when no popup/redirect is pending. */
  request: AuthFlowRequest | null;
  identities: readonly HelperIdentity[];
}

type Pending = {
  req: AuthFlowRequest;
  resolve: (c: UserCredential) => void;
  reject: (e: unknown) => void;
};

export class ServeAuthHelper {
  private pending: Pending | null = null;
  private readonly listeners = new Set<() => void>();
  private cached: HelperSnapshot | null = null;
  private identities: HelperIdentity[] = [];

  constructor(private readonly directory: HelperIdentityDirectory) {
    this.refreshIdentities();
  }

  resolver(): AuthFlowResolver {
    const open = (req: AuthFlowRequest): Promise<UserCredential> =>
      new Promise<UserCredential>((resolve, reject) => {
        if (this.pending) this.cancel();
        this.pending = { req, resolve, reject };
        this.emit();
        this.refreshIdentities();
      });
    return { openPopup: open, openRedirect: open };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): HelperSnapshot {
    this.cached ??= {
      request: this.pending?.req ?? null,
      identities: this.identities,
    };
    return this.cached;
  }

  private emit(): void {
    this.cached = null;
    for (const listener of this.listeners) listener();
  }

  private refreshIdentities(): void {
    try {
      const listed = this.directory.list();
      if (listed instanceof Promise) {
        void listed.then(
          (identities) => {
            this.identities = identities;
            this.emit();
          },
          (error) => {
            const pending = this.take();
            pending?.reject(error);
          },
        );
      } else {
        this.identities = listed;
        this.emit();
      }
    } catch (error) {
      const pending = this.take();
      pending?.reject(error);
    }
  }

  pick(uid: string): void {
    const pending = this.take();
    if (!pending) return;
    const identity = this.identities.find((candidate) => candidate.uid === uid);
    if (!identity) {
      pending.reject(authError('auth/internal-error', `unknown identity ${uid}`));
      return;
    }
    pending.resolve(this.credential(identity, pending.req.providerId));
  }

  add(spec: NewIdentitySpec): void {
    const pending = this.take();
    if (!pending) return;
    const identity: HelperIdentity = {
      uid: `${pending.req.providerId}:${spec.email}`,
      email: spec.email,
      displayName: spec.displayName ?? null,
      customClaims: spec.customClaims ?? {},
    };
    void Promise.resolve(this.directory.add?.(identity)).then(
      () => pending.resolve(this.credential(identity, pending.req.providerId)),
      pending.reject,
    );
  }

  cancel(): void {
    const pending = this.take();
    if (!pending) return;
    pending.reject(
      authError(
        'auth/popup-closed-by-user',
        'The popup has been closed by the user before finalizing the operation.',
      ),
    );
  }

  private take(): Pending | null {
    const pending = this.pending;
    this.pending = null;
    this.emit();
    return pending;
  }

  private credential(identity: HelperIdentity, providerId: string): UserCredential {
    const user: User = {
      uid: identity.uid,
      email: identity.email,
      displayName: identity.displayName,
      isAnonymous: false,
      getIdToken: async () => `pyric-serve-${identity.uid}`,
      getIdTokenResult: async () => ({
        token: `pyric-serve-${identity.uid}`,
        claims: { sub: identity.uid, ...identity.customClaims },
        expirationTime: new Date(Date.now() + 3600_000).toISOString(),
        issuedAtTime: new Date().toISOString(),
        authTime: new Date().toISOString(),
      }),
    };
    return { user, providerId, operationType: 'signIn' };
  }
}

function authError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = 'FirebaseError';
  error.code = code;
  return error;
}
