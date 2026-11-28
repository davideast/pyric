/**
 * Runtime contract tests verifying every public export, PlacementReasonCode,
 * and workflow example documented in the policy extension reference guide.
 *
 * This test intentionally does not read authored markdown from disk so it does
 * not create an unregistered docs-content reader outside `DOCS_CONTENT_READER_TESTS`
 * in `scripts/ci/check-set.ts`. Authored markdown import subpath validation runs
 * via the registered `packages/cli/test/docs-imports.test.ts` suite.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as policyModule from '../../../rules/dist/policy/index.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const DIAGNOSTICS_SRC_PATH = join(REPO_ROOT, 'packages/rules/src/policy/diagnostics.ts');
const RULES_PKG_PATH = join(REPO_ROOT, 'packages/rules/package.json');

const DOCUMENTED_RUNTIME_EXPORTS = [
  'checkPolicyIR',
  'compileBoundedModule',
  'compileFunction',
  'compilePolicy',
  'compileStorageProjections',
  'composeStorage',
  'createPolicyGuard',
  'detectPolicyKind',
  'emitStandaloneModule',
  'emitStorageModule',
  'instantiateStandaloneModule',
  'interpretModule',
  'jsonBodyExtractor',
  'lowerRtdbExpression',
  'lowerStorage',
  'parsePolicyIR',
  'PolicyDeniedError',
  'PolicyPayloadTooLargeError',
  'provePolicy',
  'toDiagnosticJsonValue',
] as const;

const DOCUMENTED_PLACEMENT_REASON_CODES = [
  'LOWERED',
  'USES_BOUNDED_OP',
  'USES_DERIVE',
  'USES_DERIVE_COLLECTION',
  'USES_HELPER_FUNCTIONS',
  'USES_LOCAL_BINDINGS',
  'MISSING_BINDING',
  'WRONG_SNAPSHOT_ORIGIN',
  'UNTRUSTED_DERIVE_INPUT',
  'PROJECTION_BUDGET_EXCEEDED',
  'EXPRESSION_BUDGET_EXCEEDED',
  'UNSUPPORTED_EXPRESSION',
  'UNVERIFIED_DERIVE_SIBLINGS',
  'INVALID_BINDING_PROJECTION',
  'LOOP_NOT_LOWERABLE',
] as const;

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('policy extension reference guide API contract', () => {
  test('declares ./experimental/policy subpath and exports all documented runtime symbols', () => {
    const pkg = JSON.parse(readFileSync(RULES_PKG_PATH, 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    expect(pkg.exports?.['./experimental/policy']).toBeDefined();

    const exportedNames = new Set(Object.keys(policyModule));
    for (const name of DOCUMENTED_RUNTIME_EXPORTS) {
      expect(exportedNames.has(name), `missing documented export: ${name}`).toBe(true);
    }
  });

  test('matches the exact PlacementReasonCode union in diagnostics.ts', () => {
    const diagSrc = readFileSync(DIAGNOSTICS_SRC_PATH, 'utf8');
    const unionMatch = /export type PlacementReasonCode =([\s\S]*?);/.exec(diagSrc);
    expect(unionMatch).not.toBeNull();
    const actual = [...unionMatch![1]!.matchAll(/'([A-Z_]+)'/g)].map((hit) => hit[1]!);
    expect(actual).toEqual([...DOCUMENTED_PLACEMENT_REASON_CODES]);
  });

  test('runs the documented dialect, bind.firestore, temp .mjs, provePolicy, and createPolicyGuard flows', async () => {
    // 1. Dialect example (transition + derive + bounded.fold + bounded.all)
    const dialectSource = `
use extension derive;
use extension bounded;

transition purchaseOrderSubmit {
  derive {
    let subtotal = bounded.fold(input.items, 0, (acc, item) => acc + item.qty * item.unitCents, 12);
    let fee = (subtotal * before.feeBps) / 10000;
    return {'subtotalCents': subtotal, 'feeCents': fee, 'totalCents': subtotal + fee};
  }
  require authenticatedTenant {
    return input.auth != null
      && input.tenant == before.tenantId
      && after.tenantId == before.tenantId;
  }
  require validLineItems {
    let ok = bounded.all(
      input.items,
      item => item.qty is int && item.qty > 0 && item.unitCents is int && item.unitCents >= 0,
      12
    );
    return ok;
  }
  require derivedTotalMatches {
    return after.totalCents == derived.totalCents
      && after.totalCents <= before.budgetLimitCents;
  }
}
`;
    expect(policyModule.detectPolicyKind(dialectSource)).toBe('transition');
    expect(policyModule.compilePolicy(dialectSource).standaloneModule().exports).toContain('judge');
    expect(policyModule.provePolicy(dialectSource, { fuzz: { seed: 7, cases: 20 } }).ok).toBe(true);

    // 2. Firestore template composition example
    const rbac = policyModule.compilePolicy(`
transition tenantDocUpdate {
  require tenantIsolation {
    return input.auth != null
      && input.tenant == before.tenantId
      && after.tenantId == before.tenantId
      && input.pathTenant == before.tenantId;
  }
  require roleFloor {
    return input.roleRank is int
      && before.minWriteRank is int
      && input.roleRank >= before.minWriteRank;
  }
}
`);
    const template = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    function rbacPolicy() { return false; }',
      '    match /tenants/{tenantId}/docs/{docId} {',
      '      allow update: if rbacPolicy();',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const { rules } = rbac.bind.firestore({
      rules: template,
      slot: 'rbacPolicy',
      placements: [{
        path: '/databases/{db}/documents/tenants/{tenantId}/docs/{docId}',
        operation: 'update',
        bindings: {
          'input.auth': 'request.auth',
          'input.tenant': 'request.auth.token.tenantId',
          'input.pathTenant': 'tenantId',
          'input.roleRank': 'request.auth.token.roleRank',
          'before.tenantId': 'resource.data.tenantId',
          'after.tenantId': 'request.resource.data.tenantId',
          'before.minWriteRank': 'resource.data.minWriteRank',
        },
      }],
    });
    expect(rules).toContain('request.auth.token.tenantId');

    // 3. Temp .mjs standalone import via pathToFileURL (no data: URIs)
    const step = policyModule.compilePolicy(`
transition step {
  require nextCount {
    return before.count is int && after.count is int && after.count == before.count + 1;
  }
}
`);
    const dir = mkdtempSync(join(tmpdir(), 'pyric-policy-doc-'));
    tempDirs.push(dir);
    const modPath = join(dir, 'step.mjs');
    writeFileSync(modPath, step.standaloneModule().moduleSource, 'utf8');
    const mod = (await import(pathToFileURL(modPath).href)) as {
      judge: (t: { before: unknown; after: unknown; input: unknown }) => { ok: boolean };
    };
    expect(mod.judge({ before: { count: 4 }, after: { count: 5 }, input: {} }).ok).toBe(true);

    // 4. provePolicy() cross-engine parity example
    const report = policyModule.provePolicy(
      `
transition nextStep {
  require increment {
    return before.count is int && before.count >= 0 && before.count <= 9007199254740991
      && after.count is int && after.count >= 0 && after.count <= 9007199254740991
      && after.count == before.count + 1;
  }
}
`,
      {
        firestore: { 'before.count': 'resource.data.count', 'after.count': 'request.resource.data.count' },
        rtdb: { 'before.count': 'data', 'after.count': 'newData' },
        scenarios: [
          { name: 'allow +1', transition: { before: { count: 1 }, after: { count: 2 }, input: {} }, expectOk: true },
          {
            name: 'deny +2',
            transition: { before: { count: 1 }, after: { count: 3 }, input: {} },
            expectOk: false,
            expectRequirement: 'increment',
          },
        ],
        fuzz: { seed: 42, cases: 64, includeAdversarial: true },
      },
    );
    expect(report.ok).toBe(true);
    expect(report.fuzz.divergences).toEqual([]);

    // 5. createPolicyGuard() Fetch handler + assert() example
    const guard = policyModule.createPolicyGuard(
      `
use extension derive;
use extension bounded;

transition checkout {
  derive {
    let subtotal = bounded.fold(input.items, 0, (acc, x) => acc + x.qty * x.unitCents, 12);
    return {'totalCents': subtotal};
  }
  require exactTotal {
    return after.totalCents == derived.totalCents && after.tenantId == before.tenantId;
  }
}
`,
      {
        engine: 'standalone',
        attachDigestHeader: true,
        includeTraceInResponse: false,
        denyStatus: 403,
        fatalStatus: 422,
      },
    );
    const post = guard.wrapFetch(
      policyModule.jsonBodyExtractor({ maxBodyBytes: 65536 }),
      async (_req, verified) =>
        new Response(
          JSON.stringify({ ok: true, totalCents: verified.derived?.totalCents }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        ),
    );
    const okRes = await post(
      new Request('https://app.example/api/checkout', {
        method: 'POST',
        body: JSON.stringify({
          before: { tenantId: 'acme' },
          after: { tenantId: 'acme', totalCents: 2500 },
          input: { items: [{ qty: 2, unitCents: 1000 }, { qty: 1, unitCents: 500 }] },
        }),
      }),
    );
    expect(okRes.status).toBe(201);
    expect(okRes.headers.get('x-policy-digest')).toMatch(/^[0-9a-f]{64}$/);
    expect(() =>
      guard.assert({
        before: { tenantId: 'acme' },
        after: { tenantId: 'acme', totalCents: 100 },
        input: { items: [{ qty: 1, unitCents: 500 }] },
      }),
    ).toThrow(policyModule.PolicyDeniedError);
  });
});
