import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {link} from './policy/build.mjs';

const [modulesDir,...encoded] = process.argv.slice(2);
const {modules, requests, beforeBoard, variant} = JSON.parse(Buffer.from(encoded.join(''),'base64').toString());
const {resolveModules} = await import(pathToFileURL(join(modulesDir,'arcade-bundler/dist/rules/modules/resolver.js')));
const {firestoreRules} = await import(pathToFileURL(join(modulesDir,'@pyric/rules/dist/index.js')));
const rules = await link(modules,resolveModules,{beforeBoard,variant});
const handle = firestoreRules(rules);
const rows = requests.map(request => {
  const id = request.description;
  try {
    const [r] = handle.simulate([request]).cases;
    if (r.unsupported) return {id,error:JSON.stringify(r.notes)};
    if (r.resourceLimit) return {id,decision:r.decision,error:JSON.stringify(r.resourceLimit),
      errorKind:'resource-limit',localExpressions:r.evaluatedExpressions};
    const error = r.trace.find(t => t.verdict === 'ERROR');
    if (r.decision === 'DENY' && error) return {id,decision:r.decision,error:error.reason || 'rule evaluation error',
      errorKind:'rule-error',localExpressions:r.evaluatedExpressions};
    return {id,decision:r.decision,localExpressions:r.evaluatedExpressions};
  } catch (err) { return {id,error:String(err?.message ?? err)}; }
});
console.log(JSON.stringify({rulesSha256:createHash('sha256').update(rules).digest('hex'),rows}));
