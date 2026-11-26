import assert from 'node:assert/strict';
import * as arcade from '../reference/native.mjs';
import {afterMove,fresh,movePatch,snapshot,transition} from './document.mjs';
import {position} from '../reference/score.mjs';

const fen='7k/7p/8/8/2B5/8/8/R3K1N1 w - -';
const shapes={knight:'g1f3',bishop:'c4d5',king:'e1f2',rook:'a1a5'};
const refusedShapes={'knight-shape':'g1g3','bishop-shape':'c4c6','king-shape':'e1e3','rook-shape':'a1b2'};
const controls={
  'retain-turn':['currentTurn','host'],'previous-board':['prevBoard',null],
  'previous-rights':['prevCastling','K'],'previous-ep':['prevEnPassant','e3'],
  'retained-source':['board.g1','wn'],'wrong-destination':['board.f3','wb'],
  'unrelated-square':['board.a1',''],'protected-guest':['guest',''],
  'last-move-extra':['lastMove.extra',['b3']],'ongoing-winner':['winner','host'],
};

export function supplement(receipt,actors,proof) {
  const {host,guest,observer}=actors;
  assert.equal(receipt.cohort,'supplement');
  assert.ok(['stock','compatibility','stronger'].includes(receipt.mode));
  const ids=[...Object.keys(shapes),...(receipt.mode==='stronger'?Object.keys(refusedShapes):[]),...Object.keys(controls),'wrong-color'];
  assert.deepEqual(receipt.rows.map(r=>r.id),ids.map(id=>'supplement-'+id));
  const board=Object.fromEntries(position(fen).board.map((v,i)=>['abcdefgh'[i%8]+(8-Math.floor(i/8)),v]));
  const initial={...fresh(host,{type:'firestore/timestamp/1.0',seconds:1767225600,nanoseconds:0}),
    guest,board,prevBoard:board,castling:'',prevCastling:'',moveCount:16,status:'playing'};
  const decisions={};
  for(const [i,row] of receipt.rows.entries()) {
    const id=ids[i],uci=shapes[id] || refusedShapes[id] || (id==='wrong-color'?'h7h6':'g1f3');
    const field=controls[id]?.[0] ?? null;
    const path='chess/'+receipt.runId+'-'+row.id;
    assert.deepEqual(row.probe,{fen,uci,field},row.id+' case inputs');
    assert.deepEqual([row.actor,row.reader],[host,observer],row.id+' identities');
    assert.equal(row.before.length,1);assert.equal(row.after.length,1);
    const [before]=row.before,[after]=row.after;
    snapshot(before,path);snapshot(after,path);proof(row.proof);proof(row.end);
    assert.deepEqual(before.data,initial,row.id+' complete seeded position');
    const moveIsLegal=arcade.legalMoves(position(fen)).includes(uci);
    assert.equal(moveIsLegal,!Object.hasOwn(refusedShapes,id) && id!=='wrong-color');
    const patch=movePatch(afterMove(initial,uci,arcade,moveIsLegal));
    if(field) {
      const value=controls[id][1];
      if(field==='prevBoard') patch.prevBoard={...board,c4:''};
      else if(field.includes('.')) {
        const [parent,key]=field.split('.');
        patch[parent]={...patch[parent],[key]:value};
      } else patch[field]=value;
    }
    assert.deepEqual(row.submitted,[{op:'update',path,data:patch}],row.id+' exact submitted patch');
    const decision=Object.hasOwn(shapes,id)?'ALLOW':'DENY';
    assert.deepEqual([row.observed,row.expected],[decision,decision],row.id+' decision');
    transition(before,after,decision==='ALLOW'?{...initial,...patch}:initial,row.id);
    decisions[row.id]=decision;
  }
  return decisions;
}
