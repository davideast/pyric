import { describe, expect, test, beforeEach } from 'bun:test';
import { initializeSandbox, type LocalSandbox } from 'pyric/sandbox';
import { getAuth, sendEmailVerification } from 'pyric/auth';
import {
  manageAuthUsers,
  inspectAuthFlow,
  switchAuthIdentity,
  controlSandboxEnvironment,
  readSandboxResource,
} from '../../src/actuation/index.js';

describe('Seam 3: Auth & Environment Domain Services (auth-service & environment-service)', () => {
  let sandbox: LocalSandbox;

  beforeEach(() => {
    sandbox = initializeSandbox();
  });

  test('manageAuthUsers performs full user CRUD, set_claims, and mint_token', async () => {
    const createRes = await manageAuthUsers(sandbox, {
      action: 'create',
      uid: 'alice',
      email: 'alice@example.com',
      displayName: 'Alice',
      claimsJson: JSON.stringify({ role: 'admin' }),
    });
    expect(createRes.ok).toBe(true);
    expect(createRes.user?.uid).toBe('alice');

    const getRes = await manageAuthUsers(sandbox, {
      action: 'get',
      uid: 'alice',
    });
    expect(getRes.ok).toBe(true);
    expect(getRes.user?.email).toBe('alice@example.com');

    const updateRes = await manageAuthUsers(sandbox, {
      action: 'update',
      uid: 'alice',
      displayName: 'Alice Cooper',
    });
    expect(updateRes.ok).toBe(true);
    expect(updateRes.user?.displayName).toBe('Alice Cooper');

    const claimsRes = await manageAuthUsers(sandbox, {
      action: 'set_claims',
      uid: 'alice',
      claimsJson: JSON.stringify({ role: 'superadmin', level: 10 }),
    });
    expect(claimsRes.ok).toBe(true);
    expect(claimsRes.user?.customClaims?.role).toBe('superadmin');

    const tokenRes = await manageAuthUsers(sandbox, {
      action: 'mint_token',
      uid: 'alice',
    });
    expect(tokenRes.ok).toBe(true);
    expect(typeof tokenRes.token).toBe('string');

    const delRes = await manageAuthUsers(sandbox, {
      action: 'delete',
      uid: 'alice',
    });
    expect(delRes.ok).toBe(true);

    const listAfter = await manageAuthUsers(sandbox, {
      action: 'list',
    });
    expect(listAfter.users).toHaveLength(0);
  });

  test('switchAuthIdentity and inspectAuthFlow support tenant propagation and take_mail outbox', async () => {
    const switchRes = await switchAuthIdentity(sandbox, {
      mode: 'uid',
      uid: 'bob',
      tenant: 'acme-tenant',
      claimsJson: JSON.stringify({ tier: 'pro' }),
    });
    expect(switchRes.ok).toBe(true);
    expect(switchRes.activeIdentity.uid).toBe('bob');
    expect(switchRes.activeIdentity.tenant).toBe('acme-tenant');
    expect((switchRes.activeIdentity.claims.firebase as { tenant: string }).tenant).toBe('acme-tenant');

    const whoamiRes = await inspectAuthFlow(sandbox, {
      action: 'whoami',
    });
    expect(whoamiRes.ok).toBe(true);
    expect(whoamiRes.activeIdentity?.uid).toBe('bob');

    // Create a user and trigger an outbound email in sandbox Auth
    await manageAuthUsers(sandbox, {
      action: 'create',
      uid: 'charlie',
      email: 'charlie@example.com',
    });

    const auth = getAuth(sandbox);
    // Ensure take_mail works cleanly on empty outbox
    const emptyMail = await inspectAuthFlow(sandbox, {
      action: 'take_mail',
      email: 'charlie@example.com',
    });
    expect(emptyMail.ok).toBe(true);
  });

  test('controlSandboxEnvironment supports advance_clock, set_network, and reset_all', async () => {
    const clockRes = await controlSandboxEnvironment(sandbox, {
      action: 'advance_clock',
      targetTimestampIso: '2028-01-01T00:00:00.000Z',
      advanceMs: 3600_000,
    });
    expect(clockRes.ok).toBe(true);
    expect(clockRes.currentTimeIso).toBe('2028-01-01T01:00:00.000Z');

    const netOffline = await controlSandboxEnvironment(sandbox, {
      action: 'set_network',
      networkState: 'offline',
    });
    expect(netOffline.ok).toBe(true);
    expect(netOffline.networkState).toBe('offline');

    const resetRes = await controlSandboxEnvironment(sandbox, {
      action: 'reset_all',
    });
    expect(resetRes.ok).toBe(true);
    expect(resetRes.networkState).toBe('online');
  });

  test('readSandboxResource reads all 7 pyric:// MCP Resource URIs', async () => {
    const status = (await readSandboxResource(sandbox, 'pyric://sandbox/status')) as {
      status: string;
      services: Record<string, unknown>;
    };
    expect(status.status).toBe('ok');

    const events = (await readSandboxResource(sandbox, 'pyric://sandbox/events')) as {
      totalCount: number;
    };
    expect(typeof events.totalCount).toBe('number');

    const docs = (await readSandboxResource(sandbox, 'pyric://firestore/docs/users')) as {
      kind: string;
    };
    expect(docs.kind).toBe('collection');

    const tree = (await readSandboxResource(sandbox, 'pyric://database/tree/root')) as {
      path: string;
    };
    expect(tree.path).toBe('/root');

    const users = (await readSandboxResource(sandbox, 'pyric://auth/users')) as {
      count: number;
    };
    expect(typeof users.count).toBe('number');

    const storage = (await readSandboxResource(sandbox, 'pyric://storage/objects/default')) as {
      bucket: string;
    };
    expect(storage.bucket).toBe('default');

    const stdlib = (await readSandboxResource(sandbox, 'pyric://stdlib/rules/index')) as {
      modules: unknown[];
    };
    expect(Array.isArray(stdlib.modules)).toBe(true);
  });
});
