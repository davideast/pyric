import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shared = await import(
  pathToFileURL(join(process.env.ORACLE_ROOT, 'adapters/_shared/v1/index.mjs')).href
);
const here = dirname(fileURLToPath(import.meta.url));
const policySource = shared.readText(join(here, 'policy.rules'));
const cases = shared.readJson(join(here, 'cases.json'));

const bindings = {
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

function makeTransition(entry) {
  return {
    before: entry.before,
    after: entry.after,
    input: {
      auth: entry.auth ? { uid: entry.auth.uid } : null,
      uid: entry.auth ? entry.auth.uid : null,
      tenant: entry.auth ? entry.auth.tenant : null,
      items: entry.items,
    },
  };
}

function evalFirestore(fsHandle, entry) {
  const [row] = fsHandle.simulate([{
    description: entry.id,
    expectation: 'ALLOW',
    method: 'update',
    path: 'tenants/acme/orders/po-42',
    auth: entry.auth ? { uid: entry.auth.uid, token: { tenantId: entry.auth.tenant } } : null,
    resource: entry.before,
    data: entry.after,
  }]).cases;
  assert.ok(row && !row.unsupported && !row.resourceLimit, 'Firestore case failed: ' + entry.id);
  return row.decision;
}

const output = await shared.scoreStandaloneProbe({
  cases,
  compileCandidate: async (runtime) => {
    const policyMod = await runtime.policy();
    const { firestoreRules } = await runtime.rules();
    if (typeof policyMod.createPolicyGuard !== 'function' || typeof policyMod.jsonBodyExtractor !== 'function') {
      throw new Error('createPolicyGuard is unavailable in this compiler build');
    }
    const compiled = policyMod.compilePolicy(policySource);
    const mixed = compiled.firestore(bindings, 'mixed');
    const lowered = mixed.filter((r) => r.predicate && !r.completeReason);
    const residual = mixed.filter((r) => !r.predicate || r.completeReason);
    assert.deepEqual(
      lowered.map((r) => r.requirement),
      ['authenticatedTenant', 'validOrderEnvelope'],
    );
    assert.deepEqual(
      residual.map((r) => r.requirement),
      ['validLineItems', 'derivedTotalMatches'],
    );
    const dbPredicate = lowered.map((r) => '(' + r.predicate + ')').join(' && ');
    const dbRules = [
      "rules_version = '2';",
      'service cloud.firestore {',
      '  match /databases/{db}/documents {',
      '    match /tenants/{tenantId}/orders/{orderId} {',
      '      allow update: if ' + dbPredicate + ';',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const fsHandle = firestoreRules(dbRules);
    const okHandler = async (_req, verified) =>
      new Response(JSON.stringify({ ok: true, derived: verified.derived }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const interpGuard = policyMod.createPolicyGuard(policySource, {
      engine: 'interpreter',
      denyStatus: 403,
      fatalStatus: 422,
    });
    const standGuard = policyMod.createPolicyGuard(policySource, {
      engine: 'standalone',
      denyStatus: 403,
      fatalStatus: 422,
    });
    const interpRoute = interpGuard.wrapFetch(policyMod.jsonBodyExtractor(), okHandler);
    const standRoute = standGuard.wrapFetch(policyMod.jsonBodyExtractor(), okHandler);
    return { fsHandle, interpRoute, standRoute, dbOnly: false };
  },
  compileMutant: async (_runtime, candidate) => {
    // Mutant omits gateway residual enforcement and trusts DB-lowered rules alone.
    return { fsHandle: candidate.fsHandle, interpRoute: null, standRoute: null, dbOnly: true };
  },
  evaluate: async (compiled, entry) => {
    if (entry.layer === 'firestore' || compiled.dbOnly) {
      return evalFirestore(compiled.fsHandle, entry);
    }
    const body = JSON.stringify(makeTransition(entry));
    const reqA = new Request('https://app.example/api/orders/submit', { method: 'POST', body });
    const reqB = new Request('https://app.example/api/orders/submit', { method: 'POST', body });
    const [resA, resB] = await Promise.all([compiled.interpRoute(reqA), compiled.standRoute(reqB)]);
    assert.equal(resA.status, resB.status, 'interpreter vs standalone HTTP drift on ' + entry.id);
    if (resA.status === 200) {
      // Zero drift check: every gateway-allowed write must also satisfy lowered Firestore rules.
      assert.equal(evalFirestore(compiled.fsHandle, entry), 'ALLOW', 'DB rejected gateway-allowed ' + entry.id);
      return 'ALLOW';
    }
    return 'DENY';
  },
  artifacts: { policySha256: shared.sha256(policySource) },
});

shared.emitProbeOutput(output, cases.map((c) => c.id));
