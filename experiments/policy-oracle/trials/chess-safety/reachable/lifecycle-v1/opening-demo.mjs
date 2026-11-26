import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {afterMove} from '../../../chess/verify/document.mjs';
import {digest,steps,traces,stamp} from './fixtures.mjs';
import {classify} from '../../exploration/classify.mjs';

const [pkg,file]=process.argv.slice(2);
execFileSync('python3',[fileURLToPath(new URL('../../exploration/v1/verify-simulator.py',import.meta.url)),pkg]);
const {firestoreRules}=await import(pathToFileURL(resolve(pkg,'dist/index.js')));
const source=readFileSync(file),handle=firestoreRules(source.toString());
const plan=JSON.parse(readFileSync(new URL('opening-plan.json',import.meta.url)));
const trace=traces.find(t=>t.name==='seed-193');
assert.deepEqual(trace.rows.slice(0,2).map(t=>t.move),[plan.trial.uci,plan.next.uci]);
let head=null;
const log=[];
function attempt(id,actor,method,data,resolved=data) {
  const before=head;
  const [r]=handle.simulate([{description:id,method,path:'chess/seed-193-opening',auth:{uid:actor},
    requestTime:stamp,expectation:'ALLOW',...(before&&{resource:before}),data}]).cases;
  const error=classify(r,true).cause;
  if(r.decision==='ALLOW')head=resolved;
  const state=s=>s&&{sha256:digest(s),moveCount:s.moveCount,currentTurn:s.currentTurn,status:s.status,lastMove:s.lastMove};
  log.push({id,actor,verdict:r.decision,localError:error,cost:r.evaluatedExpressions,before:state(before),after:state(head)});
  return r.decision==='ALLOW';
}
const first=steps(trace);
for(const setup of plan.setup) {
  const {value}=first.next();
  assert.equal(value.kind,setup.operation);
  if(!attempt(value.kind,value.actor,value.method,value.submitted,value.after))break;
}
function play(id,entry){
  const proposed={...afterMove(head,entry.uci),...entry.claim};
  return attempt(id,head[entry.seat],'update',proposed);
}
if(head?.guest) {
  const advanced=play('white-reports-draw',plan.trial)||play('white-reports-playing',plan.ifRefused);
  if(advanced)play('black-plays-on',plan.next);
}
console.log(JSON.stringify({authority:'pinned local evaluator, in-memory match head',rulesSha256:createHash('sha256').update(source).digest('hex'),
  inputPlanSha256:createHash('sha256').update(readFileSync(new URL('opening-plan.json',import.meta.url))).digest('hex'),log},null,2));
