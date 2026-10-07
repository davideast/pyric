/**
 * The auth, membership and windowed-quota patterns in one ruleset. The
 * production capture `rules-rtdb-r34-stdlib-auth-membership-quota` deploys
 * the JSON this compiles to; `corpus-lock.test.ts` fails when the two differ.
 */
import { all, authenticated, ownPath, rtdbStdlib, type PathDef } from 'pyric/rules';

const { auth, membership, timing, lifecycle } = rtdbStdlib;

export const AUTH_MEMBERSHIP_PATHS: Record<string, PathDef> = {
  '/verified': { write: auth.emailVerified(), validate: 'newData.isString()' },
  '/staff': { write: auth.emailDomain('example.com'), validate: 'newData.isString()' },
  '/admin': { write: auth.hasAnyRole('admin', 'editor'), validate: 'newData.isString()' },
  '/beta': { write: auth.hasClaim('beta'), validate: 'newData.isString()' },
  '/acme': { write: auth.tenantIs('acme'), validate: 'newData.isString()' },
  '/orgs/$orgId/docs/$docId': {
    write: auth.roleAt(['roles', { $: 'auth.uid' }], 'editor', { levelsUp: 2 }),
    validate: 'newData.isString()',
  },
  '/rooms/$roomId/messages/$msgId': {
    read: membership.memberOf(['members', { $: 'auth.uid' }], { levelsUp: 2 }),
    write: all(membership.memberOf(['members', { $: 'auth.uid' }], { levelsUp: 2 }), lifecycle.createOnly()),
    validate: 'newData.isString()',
  },
  '/rooms/$roomId/members/$uid': {
    write: membership.selfMembership('$uid'),
    validate: membership.memberFlag(),
  },
  '/posts/$postId': {
    write: all(authenticated(), lifecycle.createOnly()),
    validate: timing.countedInSameWrite(2, ['quota', { $: 'auth.uid' }]),
  },
  '/quota/$uid': {
    write: all(ownPath('$uid'), lifecycle.noDelete()),
    validate: timing.windowedQuota(2, 60_000),
  },
};
