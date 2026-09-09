/**
 * The caller identity a surface holds between calls.
 *
 * `switch_auth_identity` sets it and every data operation runs under it. A
 * tenant and a claims map are projected into the auth token by the ONE shared
 * projection, `normalizeAuthState` in `pyric/sandbox`, so
 * `request.auth.token.firebase.tenant` and `request.auth.token.<claim>`
 * resolve in rules exactly as they do for an application-issued handle.
 */
import { normalizeAuthState, type AuthLens, type AuthState } from 'pyric/sandbox';

/** The modes a caller can hold, as the canonical operation set names them. */
export type IdentityMode = 'admin' | 'uid' | 'anonymous' | 'app-session';

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
 * Project `{ uid, tenant, claims }` onto the auth state rules evaluate. The
 * claims are the token's own fields; the tenant lands on
 * `token.firebase.tenant` through the shared normalization.
 */
export function projectIdentity(
  uid: string,
  tenant?: string,
  claims?: Record<string, unknown>,
): ProjectedIdentity {
  const requested: { uid: string; token?: Record<string, unknown>; tenant?: string } = { uid };
  if (claims !== undefined) requested.token = { ...claims };
  if (tenant !== undefined) requested.tenant = tenant;
  const normalized = normalizeAuthState(requested);
  if (normalized === null) throw new Error('projectIdentity requires a uid');
  const projected: ProjectedIdentity = { uid: normalized.uid, token: normalized.token ?? {} };
  if (normalized.tenant !== undefined) projected.tenant = normalized.tenant;
  return projected;
}

/** The caller identity, held for the life of one server. */
export class SurfaceIdentity {
  private held: IdentityInput = { mode: 'app-session' };
  private readonly known = new Map<string, ProjectedIdentity>();

  /** Remember how a seeded user's tenant and claims project, for later switches and simulations. */
  remember(uid: string, tenant?: string, claims?: Record<string, unknown>): ProjectedIdentity {
    const projected = projectIdentity(uid, tenant, claims);
    this.known.set(uid, projected);
    return projected;
  }

  /** What a uid projects to: what was seeded for it, or a bare uid. */
  projectionFor(uid: string, tenant?: string, claims?: Record<string, unknown>): ProjectedIdentity {
    if (tenant !== undefined || claims !== undefined) return this.remember(uid, tenant, claims);
    const remembered = this.known.get(uid);
    if (remembered) return remembered;
    return projectIdentity(uid);
  }

  /** Set the identity every later call runs under. */
  switchTo(input: IdentityInput): IdentityInput {
    if (input.mode === 'uid') {
      if (!input.uid) throw new Error("switch_auth_identity: mode 'uid' requires a uid");
      const projected = this.projectionFor(input.uid, input.tenant, input.claims);
      const next: IdentityInput = { mode: 'uid', uid: projected.uid, claims: projected.token };
      if (projected.tenant !== undefined) next.tenant = projected.tenant;
      this.held = next;
      return next;
    }
    this.held = { mode: input.mode };
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
    if (held.mode === 'app-session') return { mode: 'app-session' };
    const projected = this.projectionFor(held.uid ?? '', held.tenant, held.claims);
    if (projected.tenant !== undefined) {
      return { mode: 'as', uid: projected.uid, token: projected.token, tenant: projected.tenant };
    }
    return { mode: 'as', uid: projected.uid, token: projected.token };
  }

  /** The identity as an `AuthState`, or null when the caller is unauthenticated. */
  authState(): AuthState {
    const held = this.held;
    if (held.mode !== 'uid' || held.uid === undefined) return null;
    const projected = this.projectionFor(held.uid, held.tenant, held.claims);
    if (projected.tenant !== undefined) {
      return { uid: projected.uid, token: projected.token, tenant: projected.tenant };
    }
    return { uid: projected.uid, token: projected.token };
  }

  /** Whether the held identity bypasses rules. */
  bypassesRules(): boolean {
    return this.held.mode === 'admin' || this.held.mode === 'app-session';
  }
}
