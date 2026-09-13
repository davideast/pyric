import { describe, expect, it } from 'bun:test';
import { projectRuntimeIdentity } from '../../../src/serve/runtime/identity.js';

describe('runtime identity', () => {
  it('preserves the profile image through the runtime identity projection', () => {
    expect(projectRuntimeIdentity({ uid: 'alice', photoURL: '/avatars/alice.png' })?.photoURL).toBe('/avatars/alice.png');
    expect(projectRuntimeIdentity({ uid: 'alice', photoURL: null })?.photoURL).toBeNull();
  });

  it('projects auth users onto the shared runtime identity seam', () => {
    expect(projectRuntimeIdentity(null)).toBeNull();
    expect(projectRuntimeIdentity({
      uid: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      ignored: true,
    })).toEqual({
      uid: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
    });
  });
});
