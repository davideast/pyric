// Staged inside arcade/runtime so these imports resolve the submitted package.
import { compilePolicy } from '@pyric/rules/experimental/policy';
import { firestoreRules } from '@pyric/rules';
import { resolveModules } from './node_modules/arcade-bundler/dist/rules/modules/resolver.js';
import { json, manifest, materialize, read, sha } from '../corpus.mjs';
import { verdict } from './score.mjs';

// The simulator wants an expectation to calculate its own pass count. Supply the
// same placeholder for every call and extract the absolute decision from verdict().
const inputs = manifest.cases.map(c => ({
  ...materialize(c), id: c.id, role: c.role, decision: 'ALLOW',
}));
const candidate = {}, errors = {}, artifacts = {};
for (const { id, generated, control } of manifest.claims) {
  const rows = inputs.filter(row => [generated, control].includes(row.id.split('/')[1]));
  try {
    const source = read('v1/rules/' + generated + '.policy');
    const emitted = compilePolicy(source).firestoreModule(manifest.bindings);
    const tree = json('v1/imports.json');
    tree.modules['../games/tictactoe/move-counter'] = emitted;
    const bundle = resolveModules(tree.root, { modules: tree.modules, sourceFile: 'firestore.modules.rules' });
    if (!bundle.success) throw Error(bundle.error.message);
    const rules = bundle.data.resolved;
    artifacts[id] = { moduleSha256: sha(emitted), rulesSha256: sha(rules) };
    const handle = firestoreRules(rules);
    for (const row of rows) {
      try { candidate[row.id] = verdict(handle, row); }
      catch (error) { errors[row.id] = String(error).slice(0, 500); }
    }
  } catch (error) {
    for (const row of rows) errors[row.id] = String(error).slice(0, 500);
  }
}
console.log(JSON.stringify({ candidate, errors, artifacts }));
