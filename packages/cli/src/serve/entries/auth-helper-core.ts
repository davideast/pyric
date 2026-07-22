/**
 * Framework-free provider account picker controller for `pyric dev`.
 *
 * The controller is intentionally backend-agnostic. It receives an identity
 * directory and returns a Firebase-shaped credential; it never constructs an
 * Auth handle or mutates a Sandbox. In SharedWorker mode the directory reads
 * the worker's user pool and the picked credential is committed by
 * `auth.acceptIdentity`. The in-page fallback supplies a mint that calls
 * `sandbox.createSignInCredential` so the resolved User carries real
 * provider metadata.
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
  /** Optional on the worker path: `auth.acceptIdentity` performs the write.
   *  Unused when a custom {@link HelperCredentialMint} owns creation. */
  add?(identity: HelperIdentity): void | Promise<void>;
}

/**
 * Mint a Firebase-shaped credential for a picker pick/add. The default mint
 * builds a bare helper User (worker path → discarded by `acceptIdentity`).
 * The in-page fallback injects `sandbox.createSignInCredential`.
 */
export type HelperCredentialMint = (
  request:
    | { kind: 'pick'; identity: HelperIdentity; providerId: string }
    | { kind: 'add'; spec: NewIdentitySpec; providerId: string },
) => UserCredential | Promise<UserCredential>;

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
  private readonly mint: HelperCredentialMint;

  constructor(
    private readonly directory: HelperIdentityDirectory,
    mint?: HelperCredentialMint,
  ) {
    this.mint = mint ?? ((request) => this.defaultMint(request));
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
    void Promise.resolve(
      this.mint({ kind: 'pick', identity, providerId: pending.req.providerId }),
    ).then(pending.resolve, pending.reject);
  }

  add(spec: NewIdentitySpec): void {
    const pending = this.take();
    if (!pending) return;
    void Promise.resolve(
      this.mint({ kind: 'add', spec, providerId: pending.req.providerId }),
    ).then(pending.resolve, pending.reject);
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

  private async defaultMint(
    request:
      | { kind: 'pick'; identity: HelperIdentity; providerId: string }
      | { kind: 'add'; spec: NewIdentitySpec; providerId: string },
  ): Promise<UserCredential> {
    if (request.kind === 'pick') {
      return bareCredential(request.identity, request.providerId);
    }
    const identity: HelperIdentity = {
      uid: `${request.providerId}:${request.spec.email}`,
      email: request.spec.email,
      displayName: request.spec.displayName ?? null,
      customClaims: request.spec.customClaims ?? {},
    };
    await Promise.resolve(this.directory.add?.(identity));
    return bareCredential(identity, request.providerId);
  }
}

/** Bare helper User — worker path discards this in favor of `acceptIdentity`. */
function bareCredential(identity: HelperIdentity, providerId: string): UserCredential {
  const issuedAtTime = new Date().toISOString();
  const expirationTime = new Date(Date.now() + 3600_000).toISOString();
  const user: User = {
    uid: identity.uid,
    email: identity.email,
    displayName: identity.displayName,
    isAnonymous: false,
    emailVerified: false,
    photoURL: null,
    phoneNumber: null,
    providerId: 'firebase',
    providerData: [
      {
        uid: identity.uid,
        displayName: identity.displayName,
        email: identity.email,
        phoneNumber: null,
        photoURL: null,
        providerId,
      },
    ],
    getIdToken: async () => `pyric-serve-${identity.uid}`,
    getIdTokenResult: async () => ({
      token: `pyric-serve-${identity.uid}`,
      claims: {
        sub: identity.uid,
        ...identity.customClaims,
        firebase: { sign_in_provider: providerId },
      },
      signInProvider: providerId,
      expirationTime,
      issuedAtTime,
      authTime: issuedAtTime,
    }),
  };
  return { user, providerId, operationType: 'signIn' };
}

function authError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.name = 'FirebaseError';
  error.code = code;
  return error;
}
