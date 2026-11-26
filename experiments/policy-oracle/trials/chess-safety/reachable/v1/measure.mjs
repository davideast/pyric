import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {positions} from './corpus.mjs';
import {sample} from '../../reference/fixtures.mjs';

const [simulator,bundle,mode='played',shardArg='0',shardsArg='1']=process.argv.slice(2);
assert.ok(['played','legal'].includes(mode));
const shard=Number(shardArg), shards=Number(shardsArg);
assert.ok(Number.isInteger(shard)&&Number.isInteger(shards)&&shard>=0&&shard<shards);
const frozen=JSON.parse(readFileSync(new URL('freeze.json',import.meta.url)));
const {firestoreRules}=await import(pathToFileURL(resolve(simulator,'dist/index.js')));
const bytes=readFileSync(bundle);
const judge=firestoreRules(bytes.toString());
const result={authority:'pinned local evaluator',rulesSha256:createHash('sha256').update(bytes).digest('hex'),
  corpus:frozen.successorDigest,mode,shard,shards,writes:0,allow:0,falseRefusals:0,reasons:{},
  firstRefusal:null,highestAllowed:null,byTrace:{}};
const digest=createHash('sha256');
let serial=0;
for(const {trace,ply,row,first} of positions()) {
  if(mode==='legal'&&!first) continue;
  const moves=mode==='legal'?row.legal:row.move?[row.move]:[];
  for(const uci of moves) {
    if(serial++%shards!==shard) continue;
    const info={trace,ply,fen:row.fen,uci};
    const {before,proposal}=sample({fen:row.fen,uci},'writer','other');
    const request={description:trace+':'+ply+':'+uci,method:'update',path:'chess/oracle',auth:{uid:'writer'},
      resource:before,data:{...before,...proposal},expectation:'ALLOW'};
    const [r]=judge.simulate([request]).cases;
    const cost=r.evaluatedExpressions;
    assert.ok(!r.unsupported,request.description);
    const reason=r.resourceLimit?'resource-limit':r.trace.some(t=>t.verdict==='ERROR')?'rule-error':'predicate';
    const record=result.byTrace[trace]??={attempted:0,allow:0,firstRefusal:null};
    result.writes++;
    record.attempted++;
    if(r.decision==='ALLOW'){
      result.allow++;
      record.allow++;
      if(cost>(result.highestAllowed?.cost??0))result.highestAllowed={...info,cost};
    }else{
      assert.equal(r.decision,'DENY');
      result.falseRefusals++;
      result.reasons[reason]=(result.reasons[reason]??0)+1;
      record.firstRefusal??={ply,uci,reason,cost};
      result.firstRefusal??={...info,reason,cost};
    }
    digest.update(JSON.stringify([trace,ply,uci,r.decision,cost,r.resourceLimit?.kind??null])+'\n');
  }
}
assert.equal(serial,mode==='legal'?frozen.legalSuccessors:frozen.recordedMoves);
result.decisionDigest=digest.digest('hex');
console.log(JSON.stringify(result,null,2));
