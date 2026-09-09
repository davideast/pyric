/**
 * The result the identity methods share: `switchHeldIdentity` changes the
 * held identity and reports it, `describeHeldIdentity` reports it without
 * changing it, and both report a uid mode with "Acting as <uid>" and any
 * other mode with "Acting as <mode>".
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import {
  describeHeldIdentity,
  switchHeldIdentity,
} from '../../../src/bridge/surface/held-identity.js';
import type { SurfaceContext } from '../../../src/bridge/surface/types.js';

function freshContext(): SurfaceContext {
  return createSurfaceContext(initializeSandbox());
}

describe('switchHeldIdentity', () => {
  it('reports a uid mode as "Acting as <uid>"', () => {
    const ctx = freshContext();
    const result = switchHeldIdentity(ctx, { mode: 'uid', uid: 'alice' });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Acting as alice');
    expect(result.data).toEqual({ identity: { mode: 'uid', uid: 'alice', claims: {} } });
  });

  it('reports admin, anonymous, and app-session as "Acting as <mode>"', () => {
    const ctx = freshContext();
    expect(switchHeldIdentity(ctx, { mode: 'admin' }).summary).toBe('Acting as admin');
    expect(switchHeldIdentity(ctx, { mode: 'anonymous' }).summary).toBe('Acting as anonymous');
    expect(switchHeldIdentity(ctx, { mode: 'app-session' }).summary).toBe('Acting as app-session');
  });

  it('changes what the context holds for the next call', () => {
    const ctx = freshContext();
    switchHeldIdentity(ctx, { mode: 'uid', uid: 'bob' });
    expect(ctx.identity.describe()).toEqual({ mode: 'uid', uid: 'bob', claims: {} });
  });
});

describe('describeHeldIdentity', () => {
  it('reports the current identity without changing it', () => {
    const ctx = freshContext();
    switchHeldIdentity(ctx, { mode: 'uid', uid: 'carol' });
    const before = ctx.identity.describe();
    const result = describeHeldIdentity(ctx);
    expect(result.summary).toBe('Acting as carol');
    expect(ctx.identity.describe()).toEqual(before);
  });

  it('reports the default app-session identity on a fresh context', () => {
    const result = describeHeldIdentity(freshContext());
    expect(result.summary).toBe('Acting as app-session');
  });
});
