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
