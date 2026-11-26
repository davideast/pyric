import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const [simulator,bundle]=process.argv.slice(2);
const {firestoreRules}=await import(pathToFileURL(resolve(simulator,'dist/index.js')));
const source=readFileSync(bundle,'utf8'), requests=JSON.parse(readFileSync(0,'utf8'));
const handle=firestoreRules(source);
const rows=handle.simulate(requests).cases.map((r,i)=>{
  const detail=r.unsupported?'unsupported':r.resourceLimit?'resource-limit':
    (r.decision==='DENY'&&r.trace.some(t=>t.verdict==='ERROR'))?'rule-error':null;
  return {id:requests[i].description,decision:r.decision,cost:r.evaluatedExpressions,...(detail&&{error:detail})};
});
console.log(JSON.stringify({sha256:createHash('sha256').update(source).digest('hex'),rows}));
