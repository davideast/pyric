/**
 * How the chip's Identity view reads the sandbox's user directory.
 *
 * The view lists users as rows in the panel's own row shape, so this module is
 * the matching and labelling half only: what a user is called, which tenant and
 * providers a record carries, and which records a typed query selects. The
 * query language is the one a developer already has in their fingers — bare
 * text over name, email, uid, tenant, providers, and claims, plus the
 * `provider:`, `role:`, `tenant:`, and `claim:` qualifiers.
 */
import type { AuthUserRecord } from 'pyric/auth';

export function userDisplayLabel(user: AuthUserRecord): string {
  if (user.displayName && user.displayName.trim().length > 0) {
    return user.displayName.trim();
  }
  if (user.email && user.email.trim().length > 0) {
    return user.email.trim();
  }
  return user.uid;
}

function extractTenantFromUser(user: AuthUserRecord): string {
  const claims = user.customClaims ?? {};
  if (typeof claims.tenant === 'string') return claims.tenant;
  if (claims.firebase && typeof (claims.firebase as Record<string, unknown>).tenant === 'string') {
    return (claims.firebase as Record<string, unknown>).tenant as string;
  }
  return '';
}

export function getUserProviders(user: AuthUserRecord): string[] {
  const providers = (user.providerUserInfo ?? [])
    .map((p) => p.providerId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (user.isAnonymous && !providers.includes('anonymous')) {
    providers.push('anonymous');
  }
  return providers;
}

/** The users a typed query selects. A disabled account is never offered: the
 * page could not run as it. */
export function filterUsers(
  users: AuthUserRecord[],
  query: string,
): AuthUserRecord[] {
  const list = users.filter((user) => user.disabled !== true);
  const q = query.trim().toLowerCase();
  if (!q) return list;

  return list.filter((u) => {
    if (q.startsWith('provider:')) {
      const target = q.slice(9).trim();
      return getUserProviders(u).some((p) => p.toLowerCase().includes(target));
    }
    if (q.startsWith('role:')) {
      const target = q.slice(5).trim();
      const c = u.customClaims ?? {};
      const role = String(c.role ?? '').toLowerCase();
      return role.includes(target);
    }
    if (q.startsWith('tenant:')) {
      const target = q.slice(7).trim();
      const tenant = extractTenantFromUser(u).toLowerCase();
      return tenant.includes(target);
    }
    if (q.startsWith('claim:')) {
      const spec = q.slice(6).trim();
      const delimiter = spec.includes('=') ? '=' : ':';
      const [key, val] = spec.split(delimiter).map((s) => s.trim());
      const c = u.customClaims ?? {};
      if (key && val !== undefined) {
        return String(c[key] ?? '').toLowerCase().includes(val);
      }
      return Object.keys(c).some((k) => k.toLowerCase().includes(spec));
    }
    if (q.includes(':') || q.includes('=')) {
      const delimiter = q.includes('=') ? '=' : ':';
      const [key, val] = q.split(delimiter).map((s) => s.trim());
      const c = u.customClaims ?? {};
      if (key && c[key] !== undefined && val !== undefined) {
        return String(c[key]).toLowerCase().includes(val);
      }
    }

    const name = (u.displayName ?? '').toLowerCase();
    const email = (u.email ?? '').toLowerCase();
    const uid = u.uid.toLowerCase();
    const tenant = extractTenantFromUser(u).toLowerCase();
    const providers = getUserProviders(u).join(' ').toLowerCase();
    const claims = JSON.stringify(u.customClaims ?? {}).toLowerCase();

    return (
      name.includes(q)
      || email.includes(q)
      || uid.includes(q)
      || tenant.includes(q)
      || providers.includes(q)
      || claims.includes(q)
    );
  });
}
