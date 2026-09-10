/**
 * What a stored user brings to an impersonation.
 *
 * The user record is the base. A tenant or a claim named in the call replaces
 * the stored one for that field and leaves every other field alone, so naming
 * a tenant does not silently drop the claims the user was created with, and
 * the token the rules evaluate is the token that user really signs in with.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { renderSurface } from '../../../src/bridge/surface/index.js';
import {
  impersonatedIdentity,
  storedIdentity,
} from '../../../src/bridge/surface/stored-identity.js';
import type { SurfaceContext } from '../../../src/bridge/surface/types.js';

/** A context whose sandbox already holds one user with a tenant and claims. */
function contextWithBilling(): SurfaceContext {
  const ctx = createSurfaceContext(initializeSandbox());
  authSandbox.seedUsers(getAuth(ctx.sandbox), [
    {
      uid: 'alice',
      email: 'alice@example.test',
      tenantId: 'tenant-a',
      customClaims: { role: 'billingAdmin', region: 'eu' },
    },
  ]);
  return ctx;
}

describe('storedIdentity', () => {
  it('reads the tenant and the claims off the stored user', () => {
    expect(storedIdentity(contextWithBilling(), 'alice')).toEqual({
      tenant: 'tenant-a',
      claims: { role: 'billingAdmin', region: 'eu' },
    });
  });

  it('reports nothing for a uid no user record holds', () => {
    expect(storedIdentity(contextWithBilling(), 'nobody')).toEqual({});
  });
});

describe('impersonatedIdentity', () => {
  it('keeps the stored claims when the call names only a tenant', () => {
    const identity = impersonatedIdentity(contextWithBilling(), 'alice', {
      tenant: 'tenant-b',
    });
    expect(identity).toEqual({
      mode: 'uid',
      uid: 'alice',
      tenant: 'tenant-b',
      claims: { role: 'billingAdmin', region: 'eu' },
    });
  });

  it('keeps the stored tenant when the call names only claims', () => {
    const identity = impersonatedIdentity(contextWithBilling(), 'alice', {
      claims: { region: 'us' },
    });
    expect(identity).toEqual({
      mode: 'uid',
      uid: 'alice',
      tenant: 'tenant-a',
      claims: { role: 'billingAdmin', region: 'us' },
    });
  });

  it('holds the stored user unchanged when the call names neither', () => {
    const identity = impersonatedIdentity(contextWithBilling(), 'alice', {});
    expect(identity).toEqual({
      mode: 'uid',
      uid: 'alice',
      tenant: 'tenant-a',
      claims: { role: 'billingAdmin', region: 'eu' },
    });
  });

  it('holds a bare uid for a user no record covers', () => {
    expect(impersonatedIdentity(contextWithBilling(), 'nobody', {})).toEqual({
      mode: 'uid',
      uid: 'nobody',
    });
  });
});

describe('impersonating a user with stored claims', () => {
  const ROLE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /invoices/{id} {
      allow read: if request.auth.token.role == 'billingAdmin';
    }
  }
}`;

  /** Call one method through its service tool, the way a client does. */
  async function call(ctx: SurfaceContext, key: string, args: Record<string, unknown>) {
    const [toolName, method] = key.split('.');
    const tool = renderSurface(undefined).tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) throw new Error(`no rendered tool named ${toolName}`);
    return tool.execute({ method, args }, ctx);
  }

  it('keeps the role in whoami when only a tenant is named', async () => {
    const ctx = contextWithBilling();
    expect((await call(ctx, 'auth.impersonate', { uid: 'alice', tenantId: 'tenant-b' })).ok).toBe(
      true,
    );
    const held = await call(ctx, 'auth.whoami', {});
    const identity = (held.data as { identity: { claims?: Record<string, unknown> } }).identity;
    expect(identity.claims).toMatchObject({ role: 'billingAdmin' });
  });

  it('keeps the role in a rules simulation when only a tenant is named', async () => {
    const ctx = contextWithBilling();
    await call(ctx, 'rules.set', { service: 'firestore', rules: ROLE_RULES });
    await call(ctx, 'auth.impersonate', { uid: 'alice', tenantId: 'tenant-b' });
    const simulated = await call(ctx, 'rules.simulate', {
      service: 'firestore',
      operation: 'get',
      path: 'invoices/i1',
    });
    expect(simulated.ok).toBe(true);
    expect((simulated.data as { allowed: boolean }).allowed).toBe(true);
  });
});
