import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sample} from '../../reference/fixtures.mjs';
import {classify} from '../classify.mjs';
const [sim,bundle,cohort='self-check-v1']=process.argv.slice(2);
assert.ok(['self-check-v1','absolute-rays-v1'].includes(cohort));
const directory=new URL('../'+cohort+'/',import.meta.url);
const sha=s=>createHash('sha256').update(s).digest('hex');
const bytes=gunzipSync(readFileSync(new URL('corpus.json.gz',directory)));
const meta=JSON.parse(readFileSync(new URL('freeze.json',directory)));
assert.equal(sha(bytes),meta.inputsSha256);
const {firestoreRules}=await import(pathToFileURL(resolve(sim,'dist/index.js')));
const source=readFileSync(bundle),handle=firestoreRules(source.toString());
const groups={},first={},stats={},outcomes=createHash('sha256');
for(const c of JSON.parse(bytes)){
  const {before,proposal}=sample(c,'writer','other');
  const [r]=handle.simulate([{path:'chess/oracle',method:'update',auth:{uid:'writer'},description:c.id,
    resource:before,data:{...before,...proposal},expectation:'ALLOW'}]).cases;
  const {kind:status,cause:error}=classify(r,c.nativeAdmission);
  const counts=groups[c.group]??={};
  counts[status]=(counts[status]??0)+1;
  stats[status]=(stats[status]??0)+1;
  if(status!=='match')first[status]??={...c,actual:r.decision,error,localExpressions:r.evaluatedExpressions};
  outcomes.update(JSON.stringify([c.id,r.decision,error,r.evaluatedExpressions])+'\n');
}
console.log(JSON.stringify({authority:'pinned local evaluator',rulesSha256:sha(source),inputsSha256:meta.inputsSha256,
  groups,stats,first,decisionsSha256:outcomes.digest('hex')},null,2));
