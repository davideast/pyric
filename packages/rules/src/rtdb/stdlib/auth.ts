/**
 * `auth`: who the request comes from: signed in, a verified email or email
 * domain, a custom-claim role, a role stored in the database, and the
 * Identity Platform tenant.
 *
 * Placement: any `.read` or `.write`. Each builder reads `auth` and
 * `auth.token`, the decoded ID token, so it does not depend on the node it
 * is placed on, except `roleAt` with `levelsUp`, which reads the stored
 * database relative to the node.
 *
 * `auth.token` carries `email` and `email_verified` only when the account
 * has an email, and custom claims as set with the Admin SDK. Each builder
 * checks `auth != null` first, and `emailDomain` checks `email_verified`
 * before it reads `email`, so a token without the claim is refused rather
 * than failing the rule. Comparison does not convert types: a claim stored
 * as the string 'true' does not equal `true`.
 */
import type { Expr, Segment } from '../constraints/types.js';
import { all, any, expr, lit, not, type Literal } from '../constraints/compose.js';
import { eq } from '../constraints/data.js';
import { authenticated } from '../constraints/atoms.js';
import { childPath, climb, pathVariable } from './expr.js';

const signedInExpr = authenticated();

/** A token claim name a rule can read with dot access. */
function claimName(builder: string, name: string): string {
  if (!/^[A-Za-z_][\w]*$/.test(name)) {
    throw new Error(`${builder}: '${name}' is not a claim name rules can read as auth.token.${name}.`);
  }
  return name;
}

/** The request is signed in. */
export const signedIn = (): Expr => signedInExpr;

/** The signed-in user's email is verified (`auth.token.email_verified == true`). */
export const emailVerified = (): Expr => all(signedInExpr, expr('auth.token.email_verified == true'));

/**
 * The signed-in user has a verified email ending in `@domain`. The comparison
 * is exact and case-sensitive, so it fails closed on a mixed-case address.
 */
export function emailDomain(domain: string): Expr {
  if (typeof domain !== 'string' || domain.length === 0 || domain.includes('@')) {
    throw new Error(`emailDomain: pass a domain such as 'example.com', got '${String(domain)}'.`);
  }
  return all(emailVerified(), expr(`auth.token.email.endsWith(${lit(`@${domain}`)})`));
}

/**
 * The custom claim `name` equals `value` (default `true`). `null` is refused:
 * a token without the claim reads it as `null`, so the check would pass for
 * every signed-in user who lacks the claim.
 */
export function hasClaim(name: string, value: Exclude<Literal, null> = true): Expr {
  if (value === null) {
    throw new Error(`hasClaim: '${name}' compared to null passes for every token without the claim; pass the value the claim must hold.`);
  }
  return all(signedInExpr, eq(`auth.token.${claimName('hasClaim', name)}`, value));
}

/** The custom claim `claim` (default 'role') equals `role`. */
export function hasRole(role: string, options: { claim?: string } = {}): Expr {
  return hasClaim(claimName('hasRole', options.claim ?? 'role'), role);
}

/** The custom claim 'role' equals one of `roles`. */
export function hasAnyRole(...roles: string[]): Expr {
  if (roles.length === 0) throw new Error('hasAnyRole: pass at least one role.');
  return all(signedInExpr, any(...roles.map((role) => eq('auth.token.role', role))));
}

/**
 * The role stored in the database at `segments` equals `role`. A string
 * segment is a key; `{ $: 'auth.uid' }` or `{ $: '$orgId' }` is a value the
 * rule reads. Without `levelsUp`, the segments start at `root`; with it,
 * they start `levelsUp` levels above the node the rule is placed on, in the
 * stored data, so the rules work wherever they are mounted.
 *
 * The roles node must not be writable by the user it describes, directly or
 * through a `.write` on any parent: `.write` cascades, so a parent grant lets
 * the user write their own role.
 */
export function roleAt(segments: Segment[], role: string, options: { levelsUp?: number } = {}): Expr {
  const path = `${climb('roleAt', 'data', options.levelsUp)}${childPath('roleAt', segments)}`;
  return all(signedInExpr, eq(`${path}.val()`, role));
}

/** The signed-in user belongs to the Identity Platform tenant `tenantId`. */
export const tenantIs = (tenantId: string): Expr =>
  all(signedInExpr, eq('auth.token.firebase.tenant', tenantId));

/** The signed-in user's tenant is the value of the path variable, such as `$tenantId`. */
export const inTenant = (pathVar: string): Expr =>
  all(signedInExpr, eq('auth.token.firebase.tenant', { $: pathVariable('inTenant', pathVar) }));
