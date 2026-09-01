import { describe, expect, it } from 'bun:test';
import { projectRuntimeIdentity } from '../../../src/serve/runtime/identity.js';

describe('runtime identity', () => {
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
