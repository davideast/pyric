import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shared = await import(
  pathToFileURL(join(process.env.ORACLE_ROOT, 'adapters/_shared/v1/index.mjs')).href
);
const here = dirname(fileURLToPath(import.meta.url));
const policySource = shared.readText(join(here, 'policy.rules'));
const rawCases = shared.readJson(join(here, 'cases.json'));

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

const bindings = {
  'input.auth': 'request.auth',
  'input.uid': 'request.auth.uid',
  'input.tenant': 'request.auth.token.tenantId',
  'input.pathTenant': 'tenantId',
  'input.role': 'request.auth.token.role',
  'input.roleRank': 'request.auth.token.roleRank',
  'before.tenantId': 'resource.data.tenantId',
  'after.tenantId': 'request.resource.data.tenantId',
  'before.minWriteRank': 'resource.data.minWriteRank',
  'after.minWriteRank': 'request.resource.data.minWriteRank',
  'before.restricted': 'resource.data.restricted',
  'after.restricted': 'request.resource.data.restricted',
  'before.status': 'resource.data.status',
  'after.status': 'request.resource.data.status',
  'before.createdBy': 'resource.data.createdBy',
  'after.createdBy': 'request.resource.data.createdBy',
  'after.updatedBy': 'request.resource.data.updatedBy',
};

const cases = rawCases.map((entry) => ({
  id: entry.id,
  method: entry.operation,
  path: entry.path,
  auth: entry.auth,
  resource: entry.before,
  data: entry.after,
}));

const output = await shared.scoreFirestoreProbe({
  cases,
  compileCandidate: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    return compilePolicy(policySource).bind.firestore({
      rules: template,
      slot: 'rbacPolicy',
      placements: [{
        path: '/databases/{db}/documents/tenants/{tenantId}/docs/{docId}',
        operation: 'update',
        bindings,
      }],
    }).rules;
  },
  compileMutant: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const rows = compilePolicy(policySource).firestore(bindings, 'complete');
    // Mutant omits roleHierarchyAuthorized and policyMetadataGuard.
    const kept = rows.filter(
      (r) => r.requirement === 'authenticatedTenantMember' || r.requirement === 'lifecycleAndAudit',
    );
    const pred = kept.map((r) => '(' + r.predicate + ')').join(' && ');
    return template.replace('allow update: if rbacPolicy();', 'allow update: if ' + pred + ';');
  },
});

shared.emitProbeOutput(output, cases.map((c) => c.id));
