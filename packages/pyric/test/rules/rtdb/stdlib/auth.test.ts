import { describe, expect, test } from 'bun:test';
import { rtdbStdlib } from 'pyric/rules';
import { runScenario, type StdlibCase, type StdlibScenario } from './harness.js';

const { auth } = rtdbStdlib;

const scenario: StdlibScenario = {
  paths: {
    '/members-only': { read: auth.signedIn(), write: auth.emailVerified(), validate: 'newData.isString()' },
    '/staff': { read: auth.emailDomain('example.com'), write: auth.emailDomain('example.com'), validate: 'newData.isString()' },
    '/admin': { read: auth.hasRole('admin'), write: auth.hasAnyRole('admin', 'editor'), validate: 'newData.isString()' },
    '/beta': { write: auth.hasClaim('beta'), validate: 'newData.isString()' },
    '/orgs/$orgId/docs/$docId': {
      read: auth.roleAt(['roles', { $: 'auth.uid' }], 'viewer', { levelsUp: 2 }),
      write: auth.roleAt(['roles', { $: 'auth.uid' }], 'editor', { levelsUp: 2 }),
      validate: 'newData.isString()',
    },
    '/tenants/$tenantId/notes/$noteId': {
      write: auth.inTenant('$tenantId'),
      validate: 'newData.isString()',
    },
    '/acme': { write: auth.tenantIs('acme'), validate: 'newData.isString()' },
  },
  cases: [],
};

const who = (uid: string, token: Record<string, unknown> = {}) => ({ uid, token });
const verified = who('alice', { email: 'alice@example.com', email_verified: true });
const unverified = who('bob', { email: 'bob@example.com', email_verified: false });
const outsider = who('carol', { email: 'carol@other.com', email_verified: true });
const write = (description: string, expectation: 'ALLOW' | 'DENY', path: string, by: StdlibCase['auth'], data?: Record<string, unknown>): StdlibCase =>
  ({ description, expectation, operation: 'write', path, auth: by, newData: 'x', ...(data ? { data } : {}) });
const orgs = { orgs: { o1: { roles: { alice: 'editor', bob: 'viewer' } } } };

scenario.cases.push(
  { description: 'a signed-in user reads the members area', expectation: 'ALLOW', operation: 'read', path: '/members-only', auth: 'dave' },
  { description: 'a signed-out user reads the members area', expectation: 'DENY', operation: 'read', path: '/members-only', auth: null },
  write('a verified email writes', 'ALLOW', '/members-only', verified),
  write('an unverified email writes', 'DENY', '/members-only', unverified),
  write('a user without an email writes', 'DENY', '/members-only', 'dave'),
  write('a verified staff email writes', 'ALLOW', '/staff', verified),
  write('a verified email from another domain writes', 'DENY', '/staff', outsider),
  write('an unverified staff email writes', 'DENY', '/staff', unverified),
  write('a user with no email writes the staff area', 'DENY', '/staff', 'dave'),
  write('an admin claim writes', 'ALLOW', '/admin', who('erin', { role: 'admin' })),
  write('an editor claim writes', 'ALLOW', '/admin', who('erin', { role: 'editor' })),
  write('a viewer claim writes', 'DENY', '/admin', who('erin', { role: 'viewer' })),
  { description: 'an editor claim reads the admin area', expectation: 'DENY', operation: 'read', path: '/admin', auth: who('erin', { role: 'editor' }) },
  write('a user without a role claim writes', 'DENY', '/admin', 'erin'),
  write('a beta claim of true writes', 'ALLOW', '/beta', who('fay', { beta: true })),
  write('a beta claim of the string true writes', 'DENY', '/beta', who('fay', { beta: 'true' })),
  write('an editor in the org database writes', 'ALLOW', '/orgs/o1/docs/d1', 'alice', orgs),
  write('a viewer in the org database writes', 'DENY', '/orgs/o1/docs/d1', 'bob', orgs),
  { description: 'a viewer in the org database reads', expectation: 'ALLOW', operation: 'read', path: '/orgs/o1/docs/d1', auth: 'bob', data: orgs },
  write('a user with no role in the org writes', 'DENY', '/orgs/o1/docs/d1', 'carol', orgs),
  write('a user of the tenant writes under it', 'ALLOW', '/tenants/t1/notes/n1', who('gus', { firebase: { tenant: 't1' } })),
  write('a user of another tenant writes under it', 'DENY', '/tenants/t1/notes/n1', who('gus', { firebase: { tenant: 't2' } })),
  write('a user with no tenant writes under it', 'DENY', '/tenants/t1/notes/n1', 'gus'),
  write('a user of the named tenant writes', 'ALLOW', '/acme', who('hal', { firebase: { tenant: 'acme' } })),
  write('a user with no tenant writes the named tenant area', 'DENY', '/acme', 'hal'),
);

describe('rtdbStdlib.auth', () => {
  test('builders compile to auth and auth.token checks', () => {
    expect(auth.signedIn()).toBe('auth != null');
    expect(auth.emailVerified()).toBe('auth != null && auth.token.email_verified == true');
    expect(auth.hasRole('admin')).toBe("auth != null && auth.token.role == 'admin'");
    expect(auth.hasClaim('beta')).toBe('auth != null && auth.token.beta == true');
    expect(auth.tenantIs('acme')).toBe("auth != null && auth.token.firebase.tenant == 'acme'");
    expect(auth.inTenant('$tenantId')).toBe('auth != null && auth.token.firebase.tenant == $tenantId');
  });

  test('builders refuse names they cannot compile', () => {
    expect(() => auth.hasClaim('a-b')).toThrow();
    expect(() => auth.hasAnyRole()).toThrow();
    expect(() => auth.emailDomain('')).toThrow();
    expect(() => auth.inTenant('tenant')).toThrow();
    expect(() => auth.roleAt([], 'x')).toThrow();
  });

  runScenario(scenario);
});
