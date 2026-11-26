import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {link} from './mobility/knight.mjs';
const [dir,...encoded]=process.argv.slice(2);
const {modules,variant,requests,returnSource}=JSON.parse(Buffer.from(encoded.join(''),'base64').toString());
const {resolveModules}=await import(pathToFileURL(join(dir,'arcade-bundler/dist/rules/modules/resolver.js')));
const {firestoreRules}=await import(pathToFileURL(join(dir,'@pyric/rules/dist/index.js')));
const source=await link(modules,resolveModules,{variant});
const handle=firestoreRules(source);
const rows=requests.map(request=>{
  const id=request.description;
  try {
    const [r]=handle.simulate([request]).cases;
    const row={id,decision:r.decision,cost:r.evaluatedExpressions};
    if (r.unsupported) return {...row,error:'unsupported',detail:r.notes};
    if (r.resourceLimit) return {...row,error:'resource-limit',detail:r.resourceLimit};
    const error=r.trace.find(t=>t.verdict==='ERROR');
    if (r.decision==='DENY' && error) return {...row,error:'rule-error',detail:error.reason};
    return row;
  } catch (error) {return {id,error:'evaluation-error',detail:String(error?.message??error)};}
});
console.log(JSON.stringify({sha256:createHash('sha256').update(source).digest('hex'),rows,...(returnSource&&{source})}));
