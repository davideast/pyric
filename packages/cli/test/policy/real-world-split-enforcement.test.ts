import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { doc, getDoc, getFirestore as getClientFirestore, updateDoc } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { deleteApp, getApps, initializeApp } from 'pyric-admin/app';
import { getFirestore as getAdminFirestore } from 'pyric-admin/firestore';
import { firestoreRules } from '../../../rules/dist/index.js';
import {
  compilePolicy,
  createPolicyGuard,
  jsonBodyExtractor,
  PolicyDeniedError,
  provePolicy,
  type HttpLikeRequest,
  type HttpLikeResponse,
  type Verdict,
} from '../../../rules/dist/policy/index.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const SPLIT_PROBE = join(
  REPO_ROOT,
  'experiments/policy-oracle/suites/real-world/split-enforcement/claims/gateway-firestore-split/v1/probes/split-writes/v1',
);

const POLICY_SOURCE = readFileSync(join(SPLIT_PROBE, 'policy.rules'), 'utf8');

const FIRESTORE_BINDINGS = {
  'input.auth': 'request.auth',
  'input.uid': 'request.auth.uid',
  'input.tenant': 'request.auth.token.tenantId',
  'before.tenantId': 'resource.data.tenantId',
  'after.tenantId': 'request.resource.data.tenantId',
  'after.submittedBy': 'request.resource.data.submittedBy',
  'before.status': 'resource.data.status',
  'after.status': 'request.resource.data.status',
  'before.currency': 'resource.data.currency',
  'after.currency': 'request.resource.data.currency',
  'before.orderNumber': 'resource.data.orderNumber',
  'after.orderNumber': 'request.resource.data.orderNumber',
  'before.budgetLimitCents': 'resource.data.budgetLimitCents',
  'after.budgetLimitCents': 'request.resource.data.budgetLimitCents',
  'before.feeBps': 'resource.data.feeBps',
  'after.feeBps': 'request.resource.data.feeBps',
  'after.totalCents': 'request.resource.data.totalCents',
};

interface SplitCase {
  id: string;
  layer: 'firestore' | 'gateway';
  auth: { uid: string; tenant: string } | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  items: Array<{ qty: number; unitCents: number }>;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(getApps().map((app) => deleteApp(app).catch(() => undefined)));
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function buildLoweredFirestoreRules(source: string): {
  rules: string;
  loweredNames: string[];
  residualNames: string[];
} {
  const compiled = compilePolicy(source);
  const rows = compiled.firestore(FIRESTORE_BINDINGS, 'mixed');
  const lowered = rows.filter((r) => r.predicate && !r.completeReason);
  const residual = rows.filter((r) => !r.predicate || r.completeReason);
  const predicate = lowered.map((r) => `(${r.predicate})`).join(' && ');
  const rules = [
    "rules_version = '2';",
    'service cloud.firestore {',
    '  match /databases/{db}/documents {',
    '    match /tenants/{tenantId}/orders/{orderId} {',
    '      allow read: if request.auth != null && request.auth.token.tenantId == resource.data.tenantId;',
    `      allow update: if ${predicate};`,
    '    }',
    '  }',
    '}',
  ].join('\n');
  return {
    rules,
    loweredNames: lowered.map((r) => r.requirement),
    residualNames: residual.map((r) => r.requirement),
  };
}

function makeOrderDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 'acme',
    orderNumber: 'PO-2026-0042',
    status: 'draft',
    currency: 'USD',
    budgetLimitCents: 50000,
    feeBps: 250,
    submittedBy: '',
    totalCents: 0,
    ...overrides,
  };
}

describe('Real-world suite 6: Fetch/Next.js createPolicyGuard + Admin SDK split enforcement', () => {
  test('splits one policy into DB-lowered rules and gateway residuals with structured reason codes', () => {
    const compiled = compilePolicy(POLICY_SOURCE);
    const mixed = compiled.firestore(FIRESTORE_BINDINGS, 'mixed');
    expect(mixed).toHaveLength(4);

    const byName = Object.fromEntries(mixed.map((row) => [row.requirement, row]));
    expect(byName.authenticatedTenant?.enforcement).toBe('standalone and database');
    expect(byName.authenticatedTenant?.diagnostics[0]?.code).toBe('LOWERED');
    expect(byName.validOrderEnvelope?.enforcement).toBe('standalone and database');
    expect(byName.validOrderEnvelope?.diagnostics[0]?.code).toBe('LOWERED');

    expect(byName.validLineItems?.enforcement).toBe('standalone only');
    expect(byName.validLineItems?.diagnostics.some((d) => d.code === 'USES_BOUNDED_OP')).toBe(true);
    expect(byName.derivedTotalMatches?.enforcement).toBe('standalone only');
    expect(
      byName.derivedTotalMatches?.diagnostics.some(
        (d) => d.code === 'USES_DERIVE_COLLECTION' || d.code === 'USES_DERIVE' || d.code === 'USES_BOUNDED_OP',
      ),
    ).toBe(true);

    const report = provePolicy(POLICY_SOURCE, {
      firestore: FIRESTORE_BINDINGS,
      fuzz: { seed: 606, cases: 80, includeAdversarial: true },
    });
    expect(report.ok).toBe(true);
    expect(report.fuzz.divergences).toEqual([]);
  });

  test('enforces zero drift across lowered Firestore rules, interpreter, standalone, and temp .mjs', async () => {
    const cases = JSON.parse(readFileSync(join(SPLIT_PROBE, 'cases.json'), 'utf8')) as SplitCase[];
    const { decisions } = JSON.parse(readFileSync(join(SPLIT_PROBE, 'raw/expected.json'), 'utf8')) as {
      decisions: Record<string, 'ALLOW' | 'DENY'>;
    };

    const { rules, loweredNames, residualNames } = buildLoweredFirestoreRules(POLICY_SOURCE);
    expect(loweredNames).toEqual(['authenticatedTenant', 'validOrderEnvelope']);
    expect(residualNames).toEqual(['validLineItems', 'derivedTotalMatches']);

    const fsHandle = firestoreRules(rules);
    const compiled = compilePolicy(POLICY_SOURCE);
    const scratch = mkdtempSync(join(tmpdir(), 'pyric-split-esm-'));
    tempDirs.push(scratch);
    const modPath = join(scratch, 'purchase-order.mjs');
    writeFileSync(modPath, compiled.standaloneModule().moduleSource, 'utf8');
    const esm = (await import(pathToFileURL(modPath).href)) as {
      judge: (t: { before: unknown; after: unknown; input: unknown }) => Verdict;
    };

    const interpGuard = createPolicyGuard(POLICY_SOURCE, { engine: 'interpreter', denyStatus: 403, fatalStatus: 422 });
    const standGuard = createPolicyGuard(POLICY_SOURCE, { engine: 'standalone', denyStatus: 403, fatalStatus: 422 });
    const okHandler = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
    const interpFetch = interpGuard.wrapFetch(jsonBodyExtractor(), okHandler);
    const standFetch = standGuard.wrapFetch(jsonBodyExtractor(), okHandler);

    for (const c of cases) {
      const transition = {
        before: c.before,
        after: c.after,
        input: {
          auth: c.auth ? { uid: c.auth.uid } : null,
          uid: c.auth?.uid ?? null,
          tenant: c.auth?.tenant ?? null,
          items: c.items,
        },
      };
      const [dbRow] = fsHandle.simulate([{
        description: c.id,
        expectation: 'ALLOW',
        method: 'update',
        path: 'tenants/acme/orders/po-42',
        auth: c.auth ? { uid: c.auth.uid, token: { tenantId: c.auth.tenant } } : null,
        resource: c.before,
        data: c.after,
      }]).cases;
      expect(dbRow?.unsupported).toBe(false);

      if (c.layer === 'firestore') {
        expect(dbRow?.decision, c.id).toBe(decisions[c.id]!);
      } else {
        const body = JSON.stringify(transition);
        const [rA, rB] = await Promise.all([
          interpFetch(new Request('https://app.example/api/orders/po-42', { method: 'POST', body })),
          standFetch(new Request('https://app.example/api/orders/po-42', { method: 'POST', body })),
        ]);
        expect(rA.status, c.id).toBe(rB.status);
        const esmDecision = esm.judge(transition).ok ? 'ALLOW' : 'DENY';
        const gwDecision = rA.status === 200 ? 'ALLOW' : 'DENY';
        expect(esmDecision, c.id).toBe(gwDecision);
        expect(gwDecision, c.id).toBe(decisions[c.id]!);
        if (gwDecision === 'ALLOW') {
          expect(dbRow?.decision, `${c.id} DB agrees with gateway allow`).toBe('ALLOW');
        }
      }
    }
  });

  test('Next.js App Router POST + pyric-admin Firestore persists valid orders and blocks tampered/fatal writes', async () => {
    for (const engine of ['interpreter', 'standalone'] as const) {
      const sandbox = initializeSandbox();
      const adminApp = initializeApp({ sandbox }, `split-admin-${engine}`);
      const adminDb = getAdminFirestore(adminApp);
      const { rules } = buildLoweredFirestoreRules(POLICY_SOURCE);
      setRules(sandbox, rules);

      const orderPath = 'tenants/acme/orders/po-42';
      await adminDb.doc(orderPath).set(makeOrderDoc());

      // Direct client update attempting a cross-tenant or over-budget write is denied by lowered Firestore rules.
      const wrongTenantDb = getClientFirestore(
        sandbox.withAuth({ uid: 'buyer-2', token: { tenantId: 'globex' } }),
      );
      await expect(
        updateDoc(doc(wrongTenantDb, orderPath), {
          status: 'submitted',
          submittedBy: 'buyer-2',
          totalCents: 24600,
        }),
      ).rejects.toThrow();

      const buyerDb = getClientFirestore(
        sandbox.withAuth({ uid: 'buyer-1', token: { tenantId: 'acme' } }),
      );
      await expect(
        updateDoc(doc(buyerDb, orderPath), {
          status: 'submitted',
          submittedBy: 'buyer-1',
          totalCents: 51250,
        }),
      ).rejects.toThrow();

      // Now verify the Next.js Route Handler gateway committing through the Admin SDK (rules-bypass lens)
      // while enforcing the full policy (envelope + derive + bounded.fold residuals).
      const guard = createPolicyGuard<{ params: { tenantId: string; orderId: string }; auth: { uid: string; tenant: string } | null }>(
        POLICY_SOURCE,
        {
          engine,
          attachDigestHeader: true,
          includeTraceInResponse: engine === 'interpreter',
          denyStatus: 403,
          fatalStatus: 422,
        },
      );

      let adminWrites = 0;
      const postOrder = guard.wrapFetch(
        async (req, ctx) => {
          const payload = (await req.json()) as {
            totalCents: number;
            items: Array<{ qty: number; unitCents: number }>;
            submittedBy?: string;
          };
          const path = `tenants/${ctx!.params.tenantId}/orders/${ctx!.params.orderId}`;
          const snap = await adminDb.doc(path).get();
          const before = snap.data() as Record<string, unknown>;
          const after = {
            ...before,
            status: 'submitted',
            submittedBy: payload.submittedBy ?? (ctx!.auth?.uid ?? ''),
            totalCents: payload.totalCents,
          };
          return {
            before,
            after,
            input: {
              auth: ctx!.auth ? { uid: ctx!.auth.uid } : null,
              uid: ctx!.auth?.uid ?? null,
              tenant: ctx!.auth?.tenant ?? null,
              items: payload.items,
            },
          };
        },
        async (_req, verified) => {
          const path = `tenants/${verified.context!.params.tenantId}/orders/${verified.context!.params.orderId}`;
          await adminDb.doc(path).set(verified.transition.after as Record<string, unknown>);
          adminWrites += 1;
          return new Response(
            JSON.stringify({ ok: true, derived: verified.derived, digest: verified.policyDigest }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        },
      );

      const routeCtx = { params: { tenantId: 'acme', orderId: 'po-42' }, auth: { uid: 'buyer-1', tenant: 'acme' } };
      const digest = await guard.digest();

      // 1. Tampered total passes envelope bounds (1000 <= 50000) but fails gateway residual (403).
      const tamperedRes = await postOrder(
        new Request('https://app.example/api/tenants/acme/orders/po-42', {
          method: 'POST',
          body: JSON.stringify({ totalCents: 1000, items: [{ qty: 2, unitCents: 10000 }, { qty: 1, unitCents: 4000 }] }),
        }),
        routeCtx,
      );
      expect(tamperedRes.status).toBe(403);
      expect(tamperedRes.headers.get('x-policy-digest')).toBe(digest);
      const tamperedBody = (await tamperedRes.json()) as {
        error: string;
        requirement: string;
        trace?: { derived?: Record<string, unknown> };
      };
      expect(tamperedBody.error).toBe('POLICY_DENIED');
      expect(tamperedBody.requirement).toBe('derivedTotalMatches');
      if (engine === 'interpreter') {
        expect(tamperedBody.trace?.derived).toEqual({ subtotalCents: 24000, feeCents: 600, totalCents: 24600 });
      } else {
        expect(tamperedBody.trace).toBeUndefined();
      }
      expect(adminWrites).toBe(0);

      // 2. Over-bound item array (13 > 12) returns fatal 422 and never writes.
      const fatalRes = await postOrder(
        new Request('https://app.example/api/tenants/acme/orders/po-42', {
          method: 'POST',
          body: JSON.stringify({ totalCents: 1332, items: Array.from({ length: 13 }, () => ({ qty: 1, unitCents: 100 })) }),
        }),
        routeCtx,
      );
      expect(fatalRes.status).toBe(422);
      expect(((await fatalRes.json()) as { error: string; fatal: boolean })).toMatchObject({
        error: 'POLICY_LIMIT_EXCEEDED',
        fatal: true,
      });
      expect(adminWrites).toBe(0);

      // 3. Valid order submits (201), writes via Admin SDK, and is readable by tenant member.
      const okRes = await postOrder(
        new Request('https://app.example/api/tenants/acme/orders/po-42', {
          method: 'POST',
          body: JSON.stringify({ totalCents: 24600, items: [{ qty: 2, unitCents: 10000 }, { qty: 1, unitCents: 4000 }] }),
        }),
        routeCtx,
      );
      expect(okRes.status).toBe(201);
      expect(okRes.headers.get('x-policy-digest')).toBe(digest);
      const okBody = (await okRes.json()) as { ok: boolean; derived: Record<string, number> };
      expect(okBody.derived).toEqual({ subtotalCents: 24000, feeCents: 600, totalCents: 24600 });
      expect(adminWrites).toBe(1);

      const persisted = await getDoc(doc(buyerDb, orderPath));
      expect(persisted.data()).toMatchObject({ status: 'submitted', submittedBy: 'buyer-1', totalCents: 24600 });

      // 4. Replay after submission is rejected (status is no longer 'draft').
      const replayRes = await postOrder(
        new Request('https://app.example/api/tenants/acme/orders/po-42', {
          method: 'POST',
          body: JSON.stringify({ totalCents: 24600, items: [{ qty: 2, unitCents: 10000 }, { qty: 1, unitCents: 4000 }] }),
        }),
        routeCtx,
      );
      expect(replayRes.status).toBe(403);
      expect(((await replayRes.json()) as { requirement: string }).requirement).toBe('validOrderEnvelope');
      expect(adminWrites).toBe(1);
    }
  });

  test('guards malformed payloads (400), oversized bodies (413), assert(), and wrapHttpHandler()', async () => {
    const guard = createPolicyGuard(POLICY_SOURCE, { engine: 'standalone' });
    const route = guard.wrapFetch(
      jsonBodyExtractor({ maxBodyBytes: 128 }),
      async () => new Response('ok', { status: 200 }),
    );

    const badJson = await route(new Request('https://app.example/api/orders', { method: 'POST', body: '{bad' }));
    expect(badJson.status).toBe(400);

    const protoPollute = await route(
      new Request('https://app.example/api/orders', {
        method: 'POST',
        body: '{"before":{"__proto__":{"x":1}},"after":{},"input":{}}',
      }),
    );
    expect(protoPollute.status).toBe(400);

    const tooBig = await route(
      new Request('https://app.example/api/orders', {
        method: 'POST',
        body: JSON.stringify({ before: { pad: 'a'.repeat(200) }, after: {}, input: {} }),
      }),
    );
    expect(tooBig.status).toBe(413);

    expect(() =>
      guard.assert({
        before: makeOrderDoc(),
        after: makeOrderDoc({ status: 'submitted', submittedBy: 'buyer-1', totalCents: 1000 }),
        input: { auth: { uid: 'buyer-1' }, uid: 'buyer-1', tenant: 'acme', items: [{ qty: 1, unitCents: 5000 }] },
      }),
    ).toThrow(PolicyDeniedError);

    let status = 0;
    let body: unknown;
    const res: HttpLikeResponse = {
      status(code: number) {
        status = code;
        return this;
      },
      json(value: unknown) {
        body = value;
      },
    };
    const httpHandler = guard.wrapHttpHandler(
      (req: HttpLikeRequest) => req.body as { before: unknown; after: unknown; input: unknown },
      (_req, r, verified) => r.status(200).json!({ ok: true, derived: verified.derived }),
    );
    await httpHandler(
      {
        method: 'POST',
        body: {
          before: makeOrderDoc(),
          after: makeOrderDoc({ status: 'submitted', submittedBy: 'buyer-1', totalCents: 10248 }),
          input: { auth: { uid: 'buyer-1' }, uid: 'buyer-1', tenant: 'acme', items: [{ qty: 3, unitCents: 3333 }] },
        },
      },
      res,
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, derived: { subtotalCents: 9999, feeCents: 249, totalCents: 10248 } });
  });
});
