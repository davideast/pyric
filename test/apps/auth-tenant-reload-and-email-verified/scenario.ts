// Hosted and in-process Auth sessions must keep a signed-in user's tenant
// pinned to its account across reload() and sibling mutations, and updateEmail()
// must reset emailVerified to false and propagate the refreshed token claims
// immediately into Firestore, RTDB, and Storage Security Rules while treating
// same-email calls as idempotent no-ops.
import assert from 'node:assert/strict';
import { scenario } from '../driver.ts';

interface ServiceChecks {
  firestore: string;
  rtdb: string;
  storage: string;
}

interface TenantCheck extends ServiceChecks {
  userTenantId: string | null;
  tokenTenant: string | null;
}

interface SameEmailCheck extends ServiceChecks {
  emailVerified: boolean | null;
  tokenUnchanged: boolean;
  idTokenFires: number;
}

interface EmailChangeCheck {
  userEmail: string | null;
  userEmailVerified: boolean;
  currentUserEmailVerified: boolean | null;
  tokenChanged: boolean;
  tokenEmail: string | null;
  tokenEmailVerified: boolean | null;
  tokenTenant: string | null;
  authStateFires: number;
  idTokenFires: number;
  verifiedFirestore: string;
  verifiedRtdb: string;
  verifiedStorage: string;
  tenantBFirestore: string;
  tenantBRtdb: string;
  tenantBStorage: string;
}

interface Checks {
  beforeVerified: ServiceChecks;
  beforeTenantB: ServiceChecks;
  afterReload: TenantCheck;
  afterSiblingOps: TenantCheck;
  afterSameEmail: SameEmailCheck;
  afterEmailChange: EmailChangeCheck;
}

declare function runChecks(email: string, nextEmail: string): Promise<Checks>;

function expected(nextEmail: string): Checks {
  return {
    beforeVerified: { firestore: 'allowed', rtdb: 'allowed', storage: 'allowed' },
    beforeTenantB: { firestore: 'denied', rtdb: 'denied', storage: 'denied' },
    afterReload: {
      userTenantId: null,
      tokenTenant: null,
      firestore: 'denied',
      rtdb: 'denied',
      storage: 'denied',
    },
    afterSiblingOps: {
      userTenantId: null,
      tokenTenant: null,
      firestore: 'denied',
      rtdb: 'denied',
      storage: 'denied',
    },
    afterSameEmail: {
      emailVerified: true,
      tokenUnchanged: true,
      idTokenFires: 0,
      firestore: 'allowed',
      rtdb: 'allowed',
      storage: 'allowed',
    },
    afterEmailChange: {
      userEmail: nextEmail,
      userEmailVerified: false,
      currentUserEmailVerified: false,
      tokenChanged: true,
      tokenEmail: nextEmail,
      tokenEmailVerified: false,
      tokenTenant: null,
      authStateFires: 0,
      idTokenFires: 1,
      verifiedFirestore: 'denied',
      verifiedRtdb: 'denied',
      verifiedStorage: 'denied',
      tenantBFirestore: 'denied',
      tenantBRtdb: 'denied',
      tenantBStorage: 'denied',
    },
  };
}

function parseChecks(output: string): Checks {
  const match = output.match(/^checks (.*)$/m);
  assert.ok(match, `no checks line in:\n${output}`);
  return JSON.parse(match[1]) as Checks;
}

export default scenario(async (app) => {
  await app.step('in-process pyric/* enforces tenant isolation and updateEmail email_verified reset across all rules engines', async () => {
    const result = await app.command('node', ['in-process.mjs'], { timeoutMs: 30_000 });
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(parseChecks(result.output), expected('inproc-next@example.com'));
  });

  const host = await app.step('start the hosted dev server', () => app.devServer());
  const env = { PYRIC_SANDBOX: `remote:${host.url}` };

  await app.step('registered Node client on hosted server enforces tenant isolation and updateEmail email_verified reset', async () => {
    await app.serverScript('admin.mjs', ['node@example.com', 'password123'], { env });
    const { output } = await app.serverScript('hosted-client.mjs', ['node@example.com', 'node-next@example.com'], {
      env,
      timeoutMs: 30_000,
    });
    assert.deepEqual(parseChecks(output), expected('node-next@example.com'));
  });

  await app.step('hosted browser page enforces tenant isolation and updateEmail email_verified reset', async () => {
    await app.serverScript('admin.mjs', ['page@example.com', 'password123'], { env });
    const page = await app.page(host.url);
    await page.waitForFunction(() => 'runChecks' in window, undefined, { timeout: 30_000 });
    const actual = await page.evaluate(
      ([email, nextEmail]) => runChecks(email, nextEmail),
      ['page@example.com', 'page-next@example.com'] as const,
    );
    assert.deepEqual(actual, expected('page-next@example.com'));
  });
});
