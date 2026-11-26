import {isDeepStrictEqual} from 'node:util';
import {afterMove,priorPosition} from './document.mjs';

export function predictAdmission(row,engine,matchPolicy) {
  const [op]=row.submitted,[snap]=row.before;
  const doc=snap.data;
  if(row.actor===null) return {observed:'DENY',requirement:'identity',status:401,after:doc};
  const gate=matchPolicy.admit(doc,row.actor,op.ply);
  if(gate!=='ok') return {observed:'DENY',requirement:gate,status:409,after:doc};
  if(![...engine.legalMoves(priorPosition(doc))].includes(op.uci)) {
    return {observed:'DENY',requirement:'legalMove',status:409,after:doc};
  }
  return {observed:'ALLOW',requirement:'committed',status:200,after:afterMove(doc,op.uci,engine,true,matchPolicy)};
}

export function compareAdmission(row,engine,matchPolicy) {
  const guess=predictAdmission(row,engine,matchPolicy);
  return {decision:guess.observed,requirement:guess.requirement,status:guess.status,
    storedMatch:isDeepStrictEqual(guess.after,row.after[0].data)};
}

// Client and race outcomes come from the original, versioned hosted reads. The
// competing writer in a recorded race can pass admission and lose at commit.
export function replayReferee(receipt,engine,metadata) {
  const records=receipt.browser.referee;
  const failures=[];
  for(const rec of records){
    const row={actor:rec.uid,submitted:[{ply:rec.ply,uci:rec.uci}],before:[{data:rec.before}]};
    const guess=predictAdmission(row,engine,metadata);
    let requirement=guess.requirement,after=guess.after;
    if(rec.id===receipt.runId && rec.verdict==='matchVersion' && requirement==='committed'){
      const won=records.find(r=>r.id===rec.id && r.verdict==='committed');
      if(won && rec.comparedVersion===won.beforeVersion && rec.comparedVersion!==won.afterVersion){
        requirement='matchVersion';
        after=predictAdmission({actor:won.uid,submitted:[{ply:won.ply,uci:won.uci}],before:[{data:won.before}]},engine,metadata).after;
      }
    }
    if(rec.verdict!==requirement || !isDeepStrictEqual(rec.after,after)){
      failures.push({id:rec.id,uci:rec.uci,expected:rec.verdict,actual:requirement,storedMatch:isDeepStrictEqual(rec.after,after)});
    }
  }
  return {records:records.length,failures};
}
