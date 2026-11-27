import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {sample} from '../../reference/fixtures.mjs';
import {afterMove,movePatch,priorPosition} from '../../../chess/verify/document.mjs';
import {position} from '../../../chess/reference/score.mjs';
import {classify} from '../classify.mjs';
const [sdk,rulesFile]=process.argv.slice(2);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const rows=gunzipSync(readFileSync(new URL('corpus.json.gz',import.meta.url)));
const native=JSON.parse(readFileSync(new URL('freeze.json',import.meta.url)));
assert.equal(sha(rows),native.sha256);
const pairs=JSON.parse(readFileSync(new URL('pairs.json',import.meta.url)));
const {firestoreRules}=await import(pathToFileURL(resolve(sdk,'dist/index.js')));
const rules=readFileSync(rulesFile),judge=firestoreRules(rules.toString());
const groups={},first={},decisions=[];
function record(r,expected,group){
  const [result]=judge.simulate([r]).cases;
  const {kind}=classify(result,expected), counts=groups[group]??={};
  counts[kind]=(counts[kind]??0)+1;
  decisions.push([r.description,group,result.decision,kind,result.evaluatedExpressions]);
  if(kind!=='match')first[group+'/'+kind]??=r.description;
  return kind==='match';
}
function evaluate(c,group) {
  // Build the canonical document from an actual double push by the other player.
  // Score that first write too. The EP attempt is still measured if it failed.
  const writer='writer',other='other';
  const previous=sample({fen:c.priorFen,uci:c.push},other,writer);
  const before={...previous.before,...previous.proposal};
  assert.deepEqual(priorPosition(before),position(c.fen));
  const make=(name,uid,resource,data)=>({description:c.id+'/'+name,method:'update',path:'chess/oracle',auth:{uid},resource,data,expectation:'ALLOW'});
  record(make('push',other,previous.before,before),true,'previous-double-push');
  const next={...before,...movePatch(afterMove(before,c.uci,undefined,false))};
  assert.deepEqual(priorPosition(next),position(c.successor));
  return record(make('capture',writer,before,next),c.nativeAdmission,group);
}
for(const c of JSON.parse(rows))evaluate(c,c.group);
let pairMatches=0;
for(const p of pairs){
  const verdicts=p.cases.map(c=>evaluate({...p,...c},'two-capturers-matched-board'));
  if(verdicts.every(Boolean))pairMatches++;
}
console.log(JSON.stringify({authority:'pinned independent Rules evaluator, two consecutive match transitions',
  rulesSha256:sha(rules),corpusSha256:sha(rows),scoreSha256:sha(JSON.stringify(decisions)),groups,
  ...(process.argv.includes('--verdict-digest')?{verdictsSha256:sha(JSON.stringify(decisions.map(([id,group,decision,kind])=>[id,group,decision,kind])))}:{}),
  writes:decisions.length,pairs:pairs.length,pairMatches,first},null,2));
