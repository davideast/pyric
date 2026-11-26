import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {positions} from '../v1/corpus.mjs';
import {readHeldOut,sha} from './authority.mjs';
import {sample} from '../../reference/fixtures.mjs';
import {classify} from '../../exploration/classify.mjs';
const [directory,sdk,file]=process.argv.slice(2);
const {catalog,archiveSha}=readHeldOut(directory);
const freeze=JSON.parse(readFileSync(new URL('freeze.json',import.meta.url)));
assert.equal(archiveSha,freeze.archiveSha256);
const code=readFileSync(file),{firestoreRules}=await import(pathToFileURL(resolve(sdk,'dist/index.js')));
const judge=firestoreRules(code.toString()),hash=createHash('sha256'),groups={},first={};
function evaluate(group,id,before,data,expected){
  const [r]=judge.simulate([{description:id,auth:{uid:'writer'},path:'chess/held-out',method:'update',resource:before,data,expectation:'ALLOW'}]).cases;
  const {kind}=classify(r,expected),stats=groups[group]??={};
  stats[kind]=(stats[kind]??0)+1;
  hash.update(JSON.stringify([id,r.decision,r.evaluatedExpressions,kind])+'\n');
  if(kind!=='match')first[group+'/'+kind]??={caseSha256:sha(id),observed:r.decision,localCost:r.evaluatedExpressions};
}
for(const {trace,ply,row,first:unique} of positions(catalog.traces)){
  if(!unique)continue;
  for(const [i,uci] of row.legal.entries()){
    const id=trace+'/'+ply+'/'+uci;
    const {before,proposal}=sample({fen:row.fen,uci},'writer','other');
    const next={...before,...proposal};
    evaluate('each-legal-successor',id,before,next,true);
    if(i===0){
      // Keep the move, full board and turn fixed; submit each possible result.
      for(const status of ['won','draw','playing']){
        const claimed={...next,status,winner:status==='won'?before.currentTurn:''};
        evaluate('three-claims-per-board',id+'/'+status,before,claimed,claimed.status===next.status&&claimed.winner===next.winner);
      }
    }
  }
}
const total=group=>Object.values(groups[group]).reduce((a,b)=>a+b,0);
assert.equal(total('each-legal-successor'),freeze.legalSuccessors);
assert.equal(total('three-claims-per-board'),3*freeze.firstMoveClaimTriplets);
console.log(JSON.stringify({authority:'pinned hidden-trace reference and independent local evaluator',archiveSha256:archiveSha,
  successorDigest:freeze.successorDigest,rulesSha256:sha(code),decisionsSha256:hash.digest('hex'),groups,first},null,2));
