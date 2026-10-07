/**
 * The caller identity a surface holds between calls.
 *
 * `switch_auth_identity` sets it and every data operation runs under it. A uid
 * with an Auth account gets the account's standard claims through the shared
 * ID token projection (`accountTokenClaims` in `pyric/sandbox/internal`), and
 * a tenant lands on `token.firebase.tenant` through `normalizeAuthState`, so
 * `request.auth.token.email_verified`, `request.auth.token.firebase.tenant`
 * and `request.auth.token.<claim>` resolve in rules exactly as they do for an
 * application-issued handle.
 */
import { normalizeAuthState, type AuthLens, type AuthState } from 'pyric/sandbox';
import { accountTokenClaims, type TokenClaimAccount } from 'pyric/sandbox/internal';

/** What the sandbox's Auth records hold for a uid, or null for a uid with no account. */
export type AccountLookup = (uid: string) => {
  account: TokenClaimAccount;
  customClaims: Record<string, unknown>;
  signInProvider: string | null;
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The modes a caller can hold.
 *
 * `default` is the mode a surface starts in and is not the app session: it is
 * what a call runs under when nothing has claimed an identity, and it bypasses
 * rules the way `admin` does. A sign-in moves the app session and leaves this
 * mode where it is; `useAppSession` adopts the app session's uid as a `uid`
 * identity, which is a snapshot rather than a subscription.
 */
export type IdentityMode = 'admin' | 'uid' | 'anonymous' | 'default';

export interface IdentityInput {
  mode: IdentityMode;
  uid?: string;
  tenant?: string;
  claims?: Record<string, unknown>;
}

/** A signed-in identity with its tenant and claims already projected into the token. */
export interface ProjectedIdentity {
  uid: string;
  tenant?: string;
  token: Record<string, unknown>;
}

/**
 * Project `{ uid, tenant, claims }` onto the auth state rules evaluate. For a
 * uid with an account, the claims (the account's custom claims when none are
 * given) pass through the ID token projection, which adds the account's
 * standard claims and `firebase.identities`; `firebase` fields the caller
 * states win. Without an account the claims are the token's own fields. The
 * tenant lands on `token.firebase.tenant` through the shared normalization.
 */
export function projectIdentity(
  uid: string,
  tenant?: string,
  claims?: Record<string, unknown>,
  accounts?: AccountLookup,
): ProjectedIdentity {
  const requested: { uid: string; token?: Record<string, unknown>; tenant?: string } = { uid };
  const known = accounts?.(uid) ?? null;
  if (known !== null) {
    const custom = claims ?? known.customClaims;
    const token = accountTokenClaims(uid, known.account, custom, known.signInProvider);
    if (isRecord(custom.firebase)) token.firebase = { ...(token.firebase as Record<string, unknown>), ...custom.firebase };
    requested.token = token;
  } else if (claims !== undefined) {
    requested.token = { ...claims };
  }
  if (tenant !== undefined) requested.tenant = tenant;
  const normalized = normalizeAuthState(requested);
  if (normalized === null) throw new Error('projectIdentity requires a uid');
  const projected: ProjectedIdentity = { uid: normalized.uid, token: normalized.token ?? {} };
  if (normalized.tenant !== undefined) projected.tenant = normalized.tenant;
  return projected;
}

/** The caller identity, held for the life of one server. */
export class SurfaceIdentity {
  private held: IdentityInput = { mode: 'default' };
  /** The uid, tenant and claims the held identity was set with, projected
   *  again on every call so a later account change reaches rules. */
  private heldInput: { uid: string; tenant?: string; claims?: Record<string, unknown> } | null = null;
  private readonly known = new Map<string, { tenant?: string; claims?: Record<string, unknown> }>();

  /** `accounts` reads the sandbox's Auth records; without it a uid's token
   *  holds only the claims the caller states. */
  constructor(private readonly accounts?: AccountLookup) {}

  /** Remember a seeded user's tenant and claims, for later switches and simulations. */
  remember(uid: string, tenant?: string, claims?: Record<string, unknown>): ProjectedIdentity {
    const entry: { tenant?: string; claims?: Record<string, unknown> } = {};
    if (tenant !== undefined) entry.tenant = tenant;
    if (claims !== undefined) entry.claims = { ...claims };
    this.known.set(uid, entry);
    return projectIdentity(uid, tenant, claims, this.accounts);
  }

  /** What a uid projects to: what was seeded for it, or its account alone. */
  projectionFor(uid: string, tenant?: string, claims?: Record<string, unknown>): ProjectedIdentity {
    if (tenant !== undefined || claims !== undefined) return this.remember(uid, tenant, claims);
    const remembered = this.known.get(uid);
    return projectIdentity(uid, remembered?.tenant, remembered?.claims, this.accounts);
  }

  /** Set the identity every later call runs under. */
  switchTo(input: IdentityInput): IdentityInput {
    if (input.mode === 'uid') {
      if (!input.uid) throw new Error("switch_auth_identity: mode 'uid' requires a uid");
      const projected = this.projectionFor(input.uid, input.tenant, input.claims);
      const next: IdentityInput = { mode: 'uid', uid: projected.uid, claims: projected.token };
      if (projected.tenant !== undefined) next.tenant = projected.tenant;
      this.held = next;
      this.heldInput = { uid: input.uid };
      return next;
    }
    this.held = { mode: input.mode };
    this.heldInput = null;
    return this.held;
  }

  /** The identity as it stands. */
  describe(): IdentityInput {
    return this.held;
  }

  /** The identity as the sandbox dispatcher's `actAs` lens. */
  lens(): AuthLens {
    const held = this.held;
    if (held.mode === 'admin') return { mode: 'admin' };
    if (held.mode === 'anonymous') return { mode: 'anon' };
    // The dispatcher's own name for the identity a call carries when nothing
    // claimed one is `app-session`, which is the lens vocabulary rather than
    // this surface's.
    if (held.mode === 'default') return { mode: 'app-session' };
    const projected = this.projectionFor(this.heldInput?.uid ?? held.uid ?? '');
    if (projected.tenant !== undefined) {
      return { mode: 'as', uid: projected.uid, token: projected.token, tenant: projected.tenant };
    }
    return { mode: 'as', uid: projected.uid, token: projected.token };
  }

  /** The identity as an `AuthState`, or null when the caller is unauthenticated. */
  authState(): AuthState {
    const held = this.held;
    if (held.mode !== 'uid' || held.uid === undefined) return null;
    const projected = this.projectionFor(this.heldInput?.uid ?? held.uid);
    if (projected.tenant !== undefined) {
      return { uid: projected.uid, token: projected.token, tenant: projected.tenant };
    }
    return { uid: projected.uid, token: projected.token };
  }

  /** Whether the held identity bypasses rules. */
  bypassesRules(): boolean {
    return this.held.mode === 'admin' || this.held.mode === 'default';
  }
}
