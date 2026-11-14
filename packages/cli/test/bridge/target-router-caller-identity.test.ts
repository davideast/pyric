import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';

import { TargetRouter } from '../../src/bridge/server/target-router.js';
import { createSurfaceContext, renderSurface } from '../../src/bridge/surface/index.js';
import { callMethod } from '../../src/bridge/surface/method-call.js';
import { methodByKey } from '../../src/bridge/surface/methods/registry.js';
import { createHostedRuntime } from '../../src/serve/hosted/runtime.js';
import { makeHostedInit, makeInMemoryPersistence } from './five-surface-parity-harness.js';

describe('TargetRouter caller identity fidelity and stored uid lookup', () => {
  it('preserves tenantId and customClaims across auth.impersonate, isolates fresh default-mode sessions, and keeps stored tenantId on discriminator overrides', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-identity-router-fidelity-'));
    writeFileSync(join(dir, '.firebaserc'), JSON.stringify({ projects: { default: 'org-alpha' } }));
    writeFileSync(join(dir, 'firebase.json'), JSON.stringify({}));

    const hostRuntime = await createHostedRuntime(
      makeHostedInit('org-alpha'),
      'http://127.0.0.1:4105',
      () => {},
      dir,
      { persistence: makeInMemoryPersistence() as never, record: false },
    );
    await hostRuntime.deployRules(
      'firestore',
      [
        "rules_version = '2';",
        'service cloud.firestore {',
        '  match /databases/{database}/documents {',
        '    match /orgs/{orgId} {',
        '      allow read, write: if request.auth != null && request.auth.token.firebase.tenant == orgId;',
        '    }',
        '    match /items/{id} {',
        "      allow read, write: if request.auth != null && request.auth.token.get('suspended', false) != true;",
        '    }',
        '  }',
        '}',
      ].join('\n'),
    );

    const makeSessionCtx = () => {
      const sb = initializeSandbox();
      const conn = {};
      const router = new TargetRouter({
        projectDir: dir,
        cacheTtlMs: 0,
        discover: async () => ({
          pointerProjectDir: dir,
          url: 'http://localhost:4105',
          base: 'http://127.0.0.1:4105',
          mcpUrl: 'http://127.0.0.1:4105/__pyric/mcp',
          instanceId: hostRuntime.instanceId,
          source: `pointer ${join(dir, '.pyric', 'serve.json')}`,
        }),
        callHosted: async (_host, key, args, projectDir, allowProduction) =>
          hostRuntime.runMethod(
            { instanceId: hostRuntime.instanceId, projectDir, key, args, allowProduction },
            conn,
          ),
      });
      return { sb, ctx: createSurfaceContext(sb, dir, router) };
    };

    const s1 = makeSessionCtx();
    const s2 = makeSessionCtx();
    const s3 = makeSessionCtx();
    const s4 = makeSessionCtx();
    const localSb = initializeSandbox();
    try {
      expect((await callMethod(methodByKey('auth.actAsAnonymous'), {}, s1.ctx)).ok).toBe(true);
      await hostRuntime.runMethod(
        {
          instanceId: hostRuntime.instanceId,
          projectDir: dir,
          key: 'auth.actAsAnonymous',
          args: {},
          allowProduction: false,
        },
        {},
      );
      expect(
        (
          await callMethod(
            methodByKey('firestore.setDoc'),
            { path: 'items/anon-denied', data: { ok: false } },
            s1.ctx,
          )
        ).ok,
      ).toBe(false);

      const freshDefaultWrite = await callMethod(
        methodByKey('firestore.setDoc'),
        { path: 'items/default-allowed', data: { ok: true } },
        s2.ctx,
      );
      expect(freshDefaultWrite.ok).toBe(true);

      const imp = await callMethod(
        methodByKey('auth.impersonate'),
        { uid: 'user-1', tenantId: 'org-alpha', customClaims: { suspended: true } },
        s3.ctx,
      );
      expect(imp.ok).toBe(true);

      const suspendedWrite = await callMethod(
        methodByKey('firestore.setDoc'),
        { path: 'items/suspended-check', data: { bypassed: true } },
        s3.ctx,
      );
      expect(suspendedWrite.ok).toBe(false);

      const tenantWrite = await callMethod(
        methodByKey('firestore.setDoc'),
        { path: 'orgs/org-alpha', data: { title: 'allowed-tenant' } },
        s3.ctx,
      );
      expect(tenantWrite.ok).toBe(true);

      const disc = renderSurface('discriminator');
      const manageUsers = disc.tools.find((t) => t.name === 'manage_auth_users')!;
      const mutateData = disc.tools.find((t) => t.name === 'mutate_sandbox_data')!;
      const diagnoseDenial = disc.tools.find((t) => t.name === 'diagnose_rule_denial')!;

      expect(
        (
          await manageUsers.execute(
            {
              action: 'import',
              usersJson: JSON.stringify([
                { uid: 'tenant-stored-1', email: 't1@example.test', tenantId: 'org-alpha' },
              ]),
            },
            s4.ctx,
          )
        ).ok,
      ).toBe(true);

      const discHostedTenantWrite = await mutateData.execute(
        {
          service: 'firestore',
          action: 'set',
          path: 'orgs/org-alpha',
          dataJson: JSON.stringify({ title: 'hosted-disc' }),
          auth: { mode: 'uid', uid: 'tenant-stored-1' },
        },
        s4.ctx,
      );
      expect(discHostedTenantWrite.ok).toBe(true);

      setFirestoreRules(
        localSb,
        "rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /orgs/{orgId} { allow read, write: if request.auth != null && request.auth.token.firebase.tenant == orgId; } } }",
      );
      const localCtx = createSurfaceContext(localSb, dir);
      await manageUsers.execute(
        {
          action: 'import',
          usersJson: JSON.stringify([
            { uid: 'tenant-local-1', email: 'tl1@example.test', tenantId: 'org-alpha' },
          ]),
        },
        localCtx,
      );
      const discLocalTenantWrite = await mutateData.execute(
        {
          service: 'firestore',
          action: 'set',
          path: 'orgs/org-alpha',
          dataJson: JSON.stringify({ title: 'local-disc' }),
          auth: { mode: 'uid', uid: 'tenant-local-1' },
        },
        localCtx,
      );
      expect(discLocalTenantWrite.ok).toBe(true);

      const diagnosed = await diagnoseDenial.execute(
        {
          service: 'firestore',
          operation: 'get',
          path: 'orgs/org-alpha',
          auth: { uid: 'adhoc-user', tenant: 'org-alpha' },
        },
        localCtx,
      );
      expect(diagnosed.ok).toBe(true);
      expect((diagnosed.data as { allowed?: boolean }).allowed).toBe(true);
    } finally {
      s1.sb.dispose();
      s2.sb.dispose();
      s3.sb.dispose();
      s4.sb.dispose();
      localSb.dispose();
      await hostRuntime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
