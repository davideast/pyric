import { describe, it, expect } from 'bun:test';
import { filterUsers, userDisplayLabel } from '../../../src/serve/runtime/chip-user-search.js';
import type { AuthUserRecord } from 'pyric/auth';

describe('chip-user-search', () => {
  const mockUsers: AuthUserRecord[] = [
    {
      uid: 'user-1',
      email: 'alice@example.com',
      displayName: 'Alice Smith',
      providerUserInfo: [{ providerId: 'password' }],
      customClaims: { role: 'admin', admin: true },
    },
    {
      uid: 'user-2',
      email: 'bob@example.com',
      displayName: 'Bob Jones',
      providerUserInfo: [{ providerId: 'google.com' }],
      customClaims: { tenant: 'tenant-omega' },
    },
    {
      uid: 'user-3',
      email: null,
      displayName: null,
      isAnonymous: true,
      providerUserInfo: [],
      customClaims: {},
    },
  ];

  it('names a user by display name, then email, then uid', () => {
    expect(userDisplayLabel(mockUsers[0])).toBe('Alice Smith');
    expect(userDisplayLabel({ uid: 'u1', email: 'test@example.com', displayName: '  ' })).toBe('test@example.com');
    expect(userDisplayLabel(mockUsers[2])).toBe('user-3');
  });

  it('returns every enabled user for an empty query', () => {
    expect(filterUsers(mockUsers, '')).toEqual(mockUsers);
  });

  it('never offers a disabled account as something the page could run as', () => {
    const disabledUser: AuthUserRecord = { uid: 'disabled-user', disabled: true };
    expect(filterUsers([...mockUsers, disabledUser], '')).toEqual(mockUsers);
  });

  it('matches freeform text against name, email, and uid', () => {
    expect(filterUsers(mockUsers, 'alice')).toEqual([mockUsers[0]]);
    expect(filterUsers(mockUsers, 'bob@example.com')).toEqual([mockUsers[1]]);
    expect(filterUsers(mockUsers, 'user-3')).toEqual([mockUsers[2]]);
  });

  it('matches freeform text against the tenant, providers, and claims', () => {
    expect(filterUsers(mockUsers, 'tenant-omega')).toEqual([mockUsers[1]]);
    expect(filterUsers(mockUsers, 'google.com')).toEqual([mockUsers[1]]);
    expect(filterUsers(mockUsers, 'anonymous')).toEqual([mockUsers[2]]);
  });

  it('reads the tenant from either the flat claim or the firebase one', () => {
    expect(filterUsers(
      [{ uid: 'u1', customClaims: { firebase: { tenant: 'nested-t' } } }],
      'tenant:nested',
    )).toHaveLength(1);
  });

  it('honours the provider, role, tenant, and claim qualifiers', () => {
    expect(filterUsers(mockUsers, 'provider:google')).toEqual([mockUsers[1]]);
    expect(filterUsers(mockUsers, 'role:admin')).toEqual([mockUsers[0]]);
    expect(filterUsers(mockUsers, 'tenant:omega')).toEqual([mockUsers[1]]);
    expect(filterUsers(mockUsers, 'claim:role=admin')).toEqual([mockUsers[0]]);
  });

  it('matches nothing for a query no record answers to', () => {
    expect(filterUsers(mockUsers, 'carol@example.com')).toEqual([]);
  });
});

describe('chip-user-search claim keys', () => {
  const users: AuthUserRecord[] = [
    { uid: 'a', customClaims: { isAdmin: true, orgId: 'Acme' } },
    { uid: 'b', customClaims: { isAdmin: false } },
  ];
  const uids = (query: string) => filterUsers(users, query).map((u) => u.uid);

  it('matches a camelCase claim key in the claim qualifier', () => {
    expect(uids('claim:isAdmin=true')).toEqual(['a']);
    expect(uids('claim:isAdmin')).toEqual(['a', 'b']);
    expect(uids('claim:orgId:acme')).toEqual(['a']);
  });

  it('matches a camelCase claim key in a bare key:value query', () => {
    expect(uids('isAdmin:true')).toEqual(['a']);
    expect(uids('orgId=acme')).toEqual(['a']);
  });

  it('matches the key whatever case the developer types', () => {
    expect(uids('claim:ISADMIN=true')).toEqual(['a']);
  });
});
