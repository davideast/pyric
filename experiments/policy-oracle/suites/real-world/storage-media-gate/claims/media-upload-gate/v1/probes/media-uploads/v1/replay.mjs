import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const shared = await import(
  pathToFileURL(join(process.env.ORACLE_ROOT, 'adapters/_shared/v1/index.mjs')).href
);
const here = dirname(fileURLToPath(import.meta.url));
const policySource = shared.readText(join(here, 'policy.rules'));
const cases = shared.readJson(join(here, 'cases.json'));

const template = [
  "rules_version = '2';",
  'service firebase.storage {',
  '  match /b/{bucket}/o {',
  '    function mediaUploadPolicy() { return false; }',
  '    match /tenants/{tenantId}/users/{uid}/media/{file} {',
  '      allow create: if mediaUploadPolicy();',
  '    }',
  '  }',
  '}',
].join('\n');

const bindings = {
  'input.auth': 'request.auth',
  'input.pathUid': 'uid',
  'input.pathTenant': 'tenantId',
  after: 'request.resource',
};

const output = await shared.scoreStorageProbe({
  cases,
  bucket: 'real-world-media-bucket',
  compileCandidate: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const compiled = compilePolicy(policySource);
    if (typeof compiled.bind?.storage !== 'function') {
      throw new Error('compilePolicy().bind.storage is unavailable in this compiler build');
    }
    return compiled.bind.storage({
      rules: template,
      slot: 'mediaUploadPolicy',
      placements: [{
        path: '/b/{bucket}/o/tenants/{tenantId}/users/{uid}/media/{file}',
        operation: 'create',
        bindings,
      }],
    }).rules;
  },
  compileMutant: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const [authRow] = compilePolicy(policySource).storage(bindings, 'complete');
    // Mutant drops MIME allowlist, size ceiling, and custom metadata contract.
    return template.replace(
      'allow create: if mediaUploadPolicy();',
      'allow create: if ' + authRow.predicate + ';',
    );
  },
});

shared.emitProbeOutput(output, cases.map((c) => c.id));
