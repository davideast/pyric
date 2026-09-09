/**
 * The `sandbox` tool's argument vocabulary: the `seed` payload schemas, and
 * the check that a `users` entry carries only the Admin SDK's own field
 * names, with a rename suggestion for the client SDK's spelling of the two
 * fields it names differently.
 */
import { describe, expect, it } from 'bun:test';

import {
  checkUserFields,
  storageObjectSeed,
  userSeed,
} from '../../../../src/bridge/surface/arguments/sandbox.js';
import { failFor } from '../../../../src/bridge/surface/method-validation.js';

const fail = failFor('sandbox', 'seed');

describe('userSeed', () => {
  it('requires uid and accepts the optional Admin SDK fields', () => {
    expect(userSeed.safeParse({ uid: 'alice' }).success).toBe(true);
    expect(
      userSeed.safeParse({
        uid: 'alice',
        email: 'alice@example.com',
        customClaims: { role: 'owner' },
        tenantId: 'tenant-a',
      }).success,
    ).toBe(true);
    expect(userSeed.safeParse({}).success).toBe(false);
  });
});

describe('storageObjectSeed', () => {
  it('requires path and contentBase64, and accepts an optional contentType', () => {
    expect(
      storageObjectSeed.safeParse({ path: 'uploads/pic.png', contentBase64: 'aGk=' }).success,
    ).toBe(true);
    expect(storageObjectSeed.safeParse({ path: 'uploads/pic.png' }).success).toBe(false);
  });
});

describe('checkUserFields', () => {
  it('suggests customClaims for the client spelling claims', () => {
    const rejection = checkUserFields({ users: [{ uid: 'a', claims: { role: 'owner' } }] }, fail);
    expect(rejection).not.toBeNull();
    expect(rejection?.data.field).toBe('users.claims');
    expect(rejection?.summary).toContain("'customClaims'");
  });

  it('suggests tenantId for the client spelling tenant', () => {
    const rejection = checkUserFields({ users: [{ uid: 'a', tenant: 'tenant-a' }] }, fail);
    expect(rejection?.summary).toContain("'tenantId'");
  });

  it('rejects a field with no rename and no close match, naming the accepted set', () => {
    const rejection = checkUserFields(
      { users: [{ uid: 'a', nonexistentField: 1 }] },
      fail,
    );
    expect(rejection).not.toBeNull();
    expect(rejection?.data.fix).toContain("Remove 'nonexistentField'");
  });

  it('passes users entries built only from the accepted fields', () => {
    expect(
      checkUserFields(
        { users: [{ uid: 'a', email: 'a@example.com', customClaims: {}, tenantId: 't' }] },
        fail,
      ),
    ).toBeNull();
  });

  it('does not check when users is absent or not an array', () => {
    expect(checkUserFields({}, fail)).toBeNull();
    expect(checkUserFields({ users: 'nope' }, fail)).toBeNull();
  });
});
