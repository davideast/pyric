/**
 * The result the identity methods share: `switchHeldIdentity` changes the
 * held identity and reports it, and `describeBothIdentities` reports the agent
 * identity and the app session side by side without changing either.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox, signInWithEmailAndPassword } from 'pyric/auth';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';

import type { AppSession } from '../../../src/bridge/surface/app-session.js';
import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import {
  describeAgentIdentity,
  describeBothIdentities,
  switchHeldIdentity,
} from '../../../src/bridge/surface/held-identity.js';
import type { SurfaceContext } from '../../../src/bridge/surface/types.js';

function freshContext(sandbox: LocalSandbox = initializeSandbox()): SurfaceContext {
  return createSurfaceContext(sandbox);
}

/** A sandbox holding one seeded tenant user with a claim rules can read. */
function seededSandbox(): LocalSandbox {
  const sandbox = initializeSandbox();
  authSandbox.seedUsers(getAuth(sandbox), [
    {
      uid: 'riley',
      email: 'riley@acme.test',
      password: 'hunter22',
      tenantId: 'tenant-acme',
      customClaims: { role: 'viewer' },
    },
  ]);
  return sandbox;
}

describe('switchHeldIdentity', () => {
  it('reports a uid mode as "Acting as <uid>"', () => {
    const ctx = freshContext();
    const result = switchHeldIdentity(ctx, { mode: 'uid', uid: 'alice' });
    expect(result.ok).toBe(true);
    expect(result.summary).toBe('Acting as alice');
    expect(result.data).toEqual({ identity: { mode: 'uid', uid: 'alice', claims: {} } });
  });

  it('reports admin, anonymous, and default as "Acting as <mode>"', () => {
    const ctx = freshContext();
    expect(switchHeldIdentity(ctx, { mode: 'admin' }).summary).toBe('Acting as admin');
    expect(switchHeldIdentity(ctx, { mode: 'anonymous' }).summary).toBe('Acting as anonymous');
    expect(switchHeldIdentity(ctx, { mode: 'default' }).summary).toBe('Acting as default');
  });

  it('changes what the context holds for the next call', () => {
    const ctx = freshContext();
    switchHeldIdentity(ctx, { mode: 'uid', uid: 'bob' });
    expect(ctx.identity.describe()).toEqual({ mode: 'uid', uid: 'bob', claims: {} });
  });
});

describe('describeAgentIdentity', () => {
  it('says that admin bypasses rules', () => {
    expect(describeAgentIdentity({ mode: 'admin' })).toBe('admin, which bypasses rules');
  });

  it('names the starting mode default, and says it bypasses rules too', () => {
    expect(describeAgentIdentity({ mode: 'default' })).toBe(
      'the sandbox default, which bypasses rules',
    );
  });

  it('names the uid and the tenant of an impersonation', () => {
    expect(describeAgentIdentity({ mode: 'uid', uid: 'riley', tenant: 'tenant-acme' })).toBe(
      'riley, tenant tenant-acme',
    );
  });
});

describe('describeBothIdentities', () => {
  it('names the agent and the app session apart on a fresh context', () => {
    const result = describeBothIdentities(freshContext());
    const data = result.data as { agent: { mode: string }; appSession: AppSession | null };
    expect(data.agent.mode).toBe('default');
    expect(data.appSession).toBe(null);
    expect(result.summary).toContain('signed out');
  });

  it('leaves the starting agent mode at default when the app signs in', async () => {
    const sandbox = seededSandbox();
    const ctx = freshContext(sandbox);
    getAuth(sandbox).tenantId = 'tenant-acme';
    await signInWithEmailAndPassword(getAuth(sandbox), 'riley@acme.test', 'hunter22');

    const data = describeBothIdentities(ctx).data as {
      agent: { mode: string };
      appSession: AppSession | null;
    };
    expect(data.agent.mode).toBe('default');
    expect(data.appSession?.uid).toBe('riley');
  });

  it('reports the app session without changing the agent identity', async () => {
    const sandbox = seededSandbox();
    const ctx = freshContext(sandbox);
    switchHeldIdentity(ctx, { mode: 'admin' });
    await signInWithEmailAndPassword(getAuth(sandbox), 'riley@acme.test', 'hunter22');

    const result = describeBothIdentities(ctx);
    const data = result.data as {
      agent: { mode: string };
      appSession: AppSession | null;
      runsAs: string;
    };
    expect(data.agent.mode).toBe('admin');
    expect(data.appSession?.uid).toBe('riley');
    expect(data.runsAs).toBe('admin, which bypasses rules');
    expect(ctx.identity.describe().mode).toBe('admin');
  });
});
