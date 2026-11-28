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
  '    function clipPolicy() { return false; }',
  '    match /clips/{uid}/{file} {',
  '      allow create: if clipPolicy();',
  '    }',
  '  }',
  '}',
].join('\n');

const bindings = { 'input.auth': 'request.auth', after: 'request.resource' };

const output = await shared.scoreStorageProbe({
  cases,
  bucket: 'policy-targets-clips',
  compileCandidate: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const compiled = compilePolicy(policySource);
    if (typeof compiled.bind?.storage !== 'function') {
      throw new Error('compilePolicy().bind.storage is unavailable in this compiler build');
    }
    return compiled.bind.storage({
      rules: template,
      slot: 'clipPolicy',
      placements: [{ path: '/b/{bucket}/o/clips/{uid}/{file}', operation: 'create', bindings }],
    }).rules;
  },
  compileMutant: async (runtime) => {
    const { compilePolicy } = await runtime.policy();
    const [ownerRow] = compilePolicy(policySource).storage(bindings, 'complete');
    return template.replace('allow create: if clipPolicy();', `allow create: if ${ownerRow.predicate};`);
  },
});

shared.emitProbeOutput(output, cases.map((c) => c.id));
